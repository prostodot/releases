const cacheName = "prosto-web-push-v1";
const base = new URL("./", self.location.href);
const scope = new URL(self.registration.scope);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const device = scope.pathname.split("/").filter(Boolean).at(-1);
const binding = new URL("binding", scope);
const storage = new URL("shown", scope);

function valid(message) {
  return (
    message &&
    message.device === device &&
    uuid.test(device) &&
    typeof message.target === "string" &&
    uuid.test(message.target) &&
    /^[a-f0-9]{32}$/.test(message.delivery) &&
    (message.kind === "record" ||
      (message.kind === "chat" &&
        typeof message.position === "string" &&
        /^[1-9][0-9]{0,18}$/.test(message.position)))
  );
}

async function show(message) {
  if (!valid(message)) return;
  const cache = await caches.open(cacheName);
  const marker = await cache.match(binding);
  if (!marker) return;
  const { records, chats } = await marker.json();
  if (
    message.kind === "record"
      ? records !== true
      : chats !== "all" && !(Array.isArray(chats) && chats.includes(message.target))
  )
    return;
  const saved = await cache.match(storage);
  const history = saved ? await saved.json() : [];
  const existing = history.find(
    ({ kind, target }) => kind === message.kind && target === message.target,
  );
  if (
    existing &&
    (message.kind === "record" || BigInt(existing.position) >= BigInt(message.position))
  )
    return;
  const tag = [device, message.kind, message.target].join(":");
  await self.registration.showNotification("Prosto Apps", {
    body: message.kind === "chat" ? "Новое сообщение" : "Новое уведомление",
    icon: new URL("pwa/icon-192.png", base).href,
    tag,
    renotify: false,
    data: message,
  });
  if (!(await cache.match(binding))) {
    const shown = await self.registration.getNotifications({ tag });
    shown.forEach((notice) => notice.close());
    return;
  }
  const seen = [...history.filter((entry) => entry !== existing), message].slice(-128);
  await cache.put(storage, new Response(JSON.stringify(seen)));
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));

let deliveries = Promise.resolve();
self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  deliveries = deliveries
    .catch(() => {})
    .then(() =>
      navigator.locks
        ? navigator.locks.request(`prosto-push-device:${device}`, () => show(message))
        : show(message),
    );
  event.waitUntil(deliveries);
});

async function openInTab(tab, message) {
  const channel = new MessageChannel();
  const routed = new Promise((resolve) => {
    const finish = (accepted) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(accepted);
    };
    const timeout = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = (event) => finish(event.data === "opened");
  });
  tab.postMessage(
    {
      type: "prosto-open-push",
      device,
      kind: message.kind,
      id: message.target,
    },
    [channel.port2],
  );
  return routed;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const message = event.notification.data;
  if (!valid(message)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName);
      if (!(await cache.match(binding))) return;
      const target = new URL("push-open", base);
      target.search = new URLSearchParams({ device, kind: message.kind, id: message.target });
      const tabs = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      const current = tabs.find(({ url }) => url.startsWith(base.href));
      if (current) {
        if (await openInTab(current, message)) {
          await current.focus();
          return;
        }
        const navigated = await current.navigate(target.href).catch(() => null);
        if (navigated) {
          await navigated.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
