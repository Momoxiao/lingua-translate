(() => {
  const root = document.documentElement;
  const localeButton = document.querySelector(".locale-toggle");

  const setLocale = (locale) => {
    const nextLocale = locale === "zh" ? "zh" : "en";
    root.dataset.locale = nextLocale;
    root.lang = nextLocale === "zh" ? "zh-CN" : "en";

    if (localeButton) {
      localeButton.setAttribute(
        "aria-label",
        nextLocale === "zh" ? "Switch to English" : "Switch to Chinese"
      );
    }

    try {
      localStorage.setItem("lingua-locale", nextLocale);
    } catch (_) {}
  };

  setLocale(root.dataset.locale);

  if (localeButton) {
    localeButton.addEventListener("click", () => {
      setLocale(root.dataset.locale === "zh" ? "en" : "zh");
    });
  }

  const reveals = document.querySelectorAll(".reveal");
  const eagerImages = document.querySelectorAll(
    ".page-gallery img, .settings-media img, .diagnostics-media img, .wide-media img"
  );

  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => {
      eagerImages.forEach((image) => {
        if (typeof image.decode === "function") {
          image.decode().catch(() => {});
        }
      });
    });
  } else {
    window.addEventListener("load", () => {
      eagerImages.forEach((image) => {
        if (typeof image.decode === "function") {
          image.decode().catch(() => {});
        }
      });
    });
  }

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );

    reveals.forEach((element) => observer.observe(element));
  } else {
    reveals.forEach((element) => element.classList.add("is-visible"));
  }
})();
