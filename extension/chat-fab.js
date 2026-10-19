(function () {
  if (window !== window.top) return;
  if (window.__iitbChatFabMounted) return;
  window.__iitbChatFabMounted = true;

  const FAB_ID = "iitb-mail-chat-fab";

  const ICON = `
    <svg viewBox="0 0 96 96" width="30" height="30" aria-hidden="true">
      <defs>
        <linearGradient id="fabRing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#67e8f9"/>
          <stop offset=".45" stop-color="#6366f1"/>
          <stop offset="1" stop-color="#a855f7"/>
        </linearGradient>
        <radialGradient id="fabFace" cx=".35" cy=".28" r=".9">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#dce6f5"/>
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="43" fill="url(#fabFace)" stroke="url(#fabRing)" stroke-width="5"/>
      <rect x="22" y="35" width="52" height="28" rx="14" fill="#0b1220"/>
      <circle cx="38" cy="49" r="7" fill="#7dd3fc"/>
      <circle cx="58" cy="49" r="7" fill="#7dd3fc"/>
      <circle cx="38" cy="49" r="4" fill="#ffffff"/>
      <circle cx="58" cy="49" r="4" fill="#ffffff"/>
    </svg>`;

  function mount() {
    if (document.getElementById(FAB_ID)) return;
    if (!document.body) return;

    const fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.type = "button";
    fab.title = "Open Mail Assistant chat";
    fab.setAttribute("aria-label", "Open Mail Assistant chat");
    fab.innerHTML = ICON;

    Object.assign(fab.style, {
      position: "fixed",
      right: "22px",
      bottom: "26px",
      width: "54px",
      height: "54px",
      borderRadius: "50%",
      border: "none",
      padding: "0",
      display: "grid",
      placeItems: "center",
      background: "#ffffff",
      boxShadow: "0 10px 26px -8px rgba(29, 42, 99, 0.45), 0 2px 6px rgba(15, 23, 42, 0.12)",
      cursor: "pointer",
      zIndex: "2147483000",
      transition: "transform .16s ease, box-shadow .16s ease",
      lineHeight: "0",
    });

    fab.addEventListener("mouseenter", () => {
      fab.style.transform = "scale(1.08)";
      fab.style.boxShadow =
        "0 14px 32px -8px rgba(79, 70, 229, 0.55), 0 2px 6px rgba(15, 23, 42, 0.12)";
    });
    fab.addEventListener("mouseleave", () => {
      fab.style.transform = "scale(1)";
      fab.style.boxShadow =
        "0 10px 26px -8px rgba(29, 42, 99, 0.45), 0 2px 6px rgba(15, 23, 42, 0.12)";
    });

    fab.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ type: "OPEN_CHAT_PANEL" }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[IITB Chat FAB]", chrome.runtime.lastError.message);
            return;
          }
          if (response && response.ok === false) {
            console.warn("[IITB Chat FAB] could not open the chat panel:", response.error);
          }
        });
      } catch (err) {
        console.warn("[IITB Chat FAB] sendMessage failed:", err);
      }
    });

    document.body.appendChild(fab);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(FAB_ID)) mount();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true });
  }
})();
