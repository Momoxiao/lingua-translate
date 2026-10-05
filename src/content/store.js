/**
 * Lingua — subtitle store (isolated world).
 * Single source of truth for cues, translations and pipeline status.
 * Registers onto YTST.store.
 */
(function (root) {
  'use strict';
  const NS = (root.YTST = root.YTST || {});

  const STATUS = {
    IDLE: 'idle',
    LOADING: 'loading', // fetching the caption track
    TRANSLATING: 'translating',
    READY: 'ready',
    EMPTY: 'empty', // no captions available for this video
    ERROR: 'error',
    LIVE: 'live', // realtime DOM mode
  };

  const listeners = new Map();

  const state = {
    status: STATUS.IDLE,
    videoId: '',
    tracks: [],
    sourceTrack: null,
    cues: [],
    translations: [], // index-aligned with cues; null until translated
    pending: new Set(), // cue indexes currently in flight
    progress: { done: 0, total: 0 },
    error: '',
    liveMode: false,
    enabled: true,
  };

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event).delete(cb);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (e) {
        /* a broken listener must not break the pipeline */
      }
    }
  }

  function setStatus(status, extra) {
    state.status = status;
    emit('status', { status, ...(extra || {}) });
  }

  function reset(keepSettings) {
    state.status = STATUS.IDLE;
    state.tracks = [];
    state.sourceTrack = null;
    state.cues = [];
    state.translations = [];
    state.pending = new Set();
    state.progress = { done: 0, total: 0 };
    state.error = '';
    if (!keepSettings) state.liveMode = false;
    emit('reset', null);
  }

  function setCues(cues) {
    state.cues = cues || [];
    state.translations = new Array(state.cues.length).fill(null);
    state.pending = new Set();
    state.progress = { done: 0, total: state.cues.length };
    emit('cues', state.cues);
  }

  function setTranslation(index, text) {
    if (index < 0 || index >= state.cues.length) return;
    state.translations[index] = text;
    state.pending.delete(index);
    emit('translation', { index, text });
  }

  function setTranslations(startIndex, values) {
    for (let i = 0; i < values.length; i++) {
      const idx = startIndex + i;
      if (idx >= state.cues.length) break;
      if (values[i]) state.translations[idx] = values[i];
      state.pending.delete(idx);
    }
    emit('translations', { startIndex, count: values.length });
  }

  function markPending(indexes) {
    for (const i of indexes) state.pending.add(i);
    emit('pending', indexes);
  }

  /** Bulk write for non-contiguous results: pairs = [[index, text], ...] */
  function applyMany(pairs) {
    let n = 0;
    for (const [idx, text] of pairs) {
      if (idx < 0 || idx >= state.cues.length) continue;
      if (text) {
        state.translations[idx] = text;
        n++;
      }
      state.pending.delete(idx);
    }
    emit('translations', { count: n });
  }

  function setProgress(done, total) {
    state.progress = { done, total };
    emit('progress', state.progress);
  }

  function cueAt(time) {
    return NS.subtitles.cueAt(state.cues, time);
  }

  function translatedCount() {
    let n = 0;
    for (const t of state.translations) if (t) n++;
    return n;
  }

  NS.store = {
    STATUS,
    state,
    on,
    emit,
    setStatus,
    reset,
    setCues,
    setTranslation,
    setTranslations,
    applyMany,
    markPending,
    setProgress,
    cueAt,
    translatedCount,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
