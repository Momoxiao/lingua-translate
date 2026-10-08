/**
 * Lingua — YouTube caption fallback (service worker).
 *
 * The page's own caption URL is signed with a Proof-of-Origin token that the
 * player mints after playback starts. When that token misses our sniffing
 * window, every request built from the page response returns HTTP 200 with an
 * empty body even though the video has captions.
 *
 * YouTube's mobile player responses are a separate path: their caption URLs do
 * not require that page-minted token. Requesting one here gives the content
 * script a complete track instead of falling through to line-by-line DOM
 * scraping. This is deliberately the last strategy — the normal page path is
 * faster and stays first.
 *
 * Registers onto Lingua.bg.youtubeCaptions.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const bg = (NS.bg = NS.bg || {});

  const PLAYER_ENDPOINT =
    'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  /**
   * Mobile clients are the compatibility path. IOS is tried first because its
   * caption URLs returned real JSON bodies without a `pot` in live checks;
   * ANDROID is the second chance for videos where the iOS response is gated.
   */
  const CLIENTS = [
    {
      name: 'IOS',
      id: '5',
      version: '20.10.4',
      deviceModel: 'iPhone16,2',
      userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)',
    },
    {
      name: 'ANDROID',
      id: '3',
      version: '20.10.38',
      deviceModel: 'Pixel 9',
      userAgent:
        'com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip',
    },
  ];

  function normalizeCode(code) {
    return NS.subtitles ? NS.subtitles.normalizeLang(code) : String(code || '').toLowerCase();
  }

  /** Pick the track the caller asked for, or the closest language match. */
  function pickTrack(tracks, wanted) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    if (!wanted || wanted === 'auto') return tracks[0];
    const code = normalizeCode(wanted);
    return (
      tracks.find((t) => t && t.languageCode === wanted) ||
      tracks.find((t) => t && normalizeCode(t.languageCode) === code) ||
      tracks[0]
    );
  }

  function clientContext(client, language) {
    return {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        deviceModel: client.deviceModel,
        hl: language || 'en',
        gl: 'US',
      },
    };
  }

  function captionUrl(baseUrl) {
    try {
      const u = new URL(baseUrl);
      u.searchParams.set('fmt', 'json3');
      return u.toString();
    } catch (e) {
      return baseUrl;
    }
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error('invalid JSON');
    }
  }

  async function fetchTrackWithClient(videoId, wanted, client) {
    const player = await fetchJson(PLAYER_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-youtube-client-name': client.id,
        'x-youtube-client-version': client.version,
        'user-agent': client.userAgent,
        accept: 'application/json',
      },
      body: JSON.stringify({
        context: clientContext(client),
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    const renderer = player && player.captions && player.captions.playerCaptionsTracklistRenderer;
    const tracks = (renderer && renderer.captionTracks) || [];
    const track = pickTrack(tracks, wanted);
    if (!track || !track.baseUrl) return { cues: [], source: 'mobile-client', client: client.name };

    const res = await fetch(captionUrl(track.baseUrl), {
      headers: { 'user-agent': client.userAgent, accept: '*/*' },
    });
    const body = await res.text();
    const cues = NS.subtitles.parseTimedText(body);
    return {
      cues,
      bytes: body.length,
      source: 'mobile-client',
      client: client.name,
      languageCode: track.languageCode || '',
      langMismatch: !!wanted && wanted !== 'auto' && normalizeCode(track.languageCode) !== normalizeCode(wanted),
    };
  }

  /**
   * @param {{videoId:string, languageCode?:string, hl?:string}} opts
   * @returns {Promise<{cues:Array, bytes:number, source:string, client:string}>}
   */
  async function fetchCaptions(opts) {
    const videoId = (opts && opts.videoId) || '';
    if (!/^[\w-]{6,20}$/.test(videoId)) {
      return { cues: [], bytes: 0, source: 'mobile-client', error: 'invalid video id' };
    }

    let last = { cues: [], bytes: 0, source: 'mobile-client' };
    for (const client of CLIENTS) {
      try {
        const result = await fetchTrackWithClient(videoId, opts.languageCode, client);
        if (result.cues && result.cues.length) return result;
        last = result;
      } catch (e) {
        last = {
          cues: [],
          bytes: 0,
          source: 'mobile-client',
          client: client.name,
          error: (e && e.message) || String(e),
        };
      }
    }
    return last;
  }

  bg.youtubeCaptions = { fetchCaptions, pickTrack, captionUrl, CLIENTS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
