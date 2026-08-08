// fluxo preview shim — puente http→same-origin-https para el Firebase Emulator Suite (docs/20 · P2).
//
// POR QUÉ EXISTE (esto NO es opcional, es la única forma de que ande):
// Los SDK de FlutterFire, en WEB, arman la URL del emulador con `http://` HARDCODEADO — no hay
// parámetro para pedir https:
//   · firebase_auth_web 6.2.6 (firebase_auth_web.dart:550):  final String origin = 'http://$host:$port';
//   · cloud_functions 6.3.6 (firebase_functions.dart:117):   _origin = 'http://$mappedHost:$port';
//   · cloud_firestore 6.8.0: useFirestoreEmulator DESCARTA sslEnabled en web y el JS SDK computa
//     `ssl: isCloudWorkstation(host)` → false para cualquier host que no termine en
//     `.cloudworkstations.dev` (dominio de Google, no podemos apuntarlo a nuestro server).
// El preview se sirve por HTTPS (Caddy + sslip.io), así que esos pedidos http serían MIXED CONTENT y el
// browser los bloquea. Resultado sin shim: la app carga y no conecta con nada.
//
// QUÉ HACE: parchea fetch/XHR/WebSocket y reescribe TODA URL absoluta http:// (y ws://) al ORIGEN DE LA
// PÁGINA, conservando path+query. El edge (Caddy) rutea esos paths a cada emulador por prefijo
// (/identitytoolkit.googleapis.com/* → auth, /google.firestore.v1.Firestore/* y /v1/* → firestore,
// /demo-fluxo/* → functions, /v0/b/* → storage). El browser NUNCA ve un pedido http: reescribimos el
// string ANTES de emitirlo, así que no hay mixed content que bloquear.
//
// POR QUÉ "toda URL http" y no una allowlist de hosts: el host del emulador entra por --dart-define y no
// queremos que el shim dependa de ese valor. En un preview, el ÚNICO tráfico http absoluto que emite la
// app es el del emulador — cualquier otro estaría bloqueado por mixed content de todos modos, así que
// reescribirlo no empeora nada. Los assets del engine de Flutter (canvaskit en gstatic) son https y no
// se tocan.
//
// ALCANCE: preview efímero ÚNICAMENTE. Este archivo lo inyecta build-web.sh en el index.html del build
// de preview; NUNCA se commitea al repo del cliente ni entra en un build real.
(function () {
  'use strict';

  var origin = window.location.origin;
  var secure = window.location.protocol === 'https:';
  var rewritten = 0;

  // http://cualquier-host:puerto/path?q  →  <origen de la página>/path?q   (idem ws:// → ws(s)://)
  // Devuelve la URL intacta si no aplica (https, relativa, o no parseable).
  function rewrite(url) {
    if (typeof url !== 'string') return url;
    var isHttp = url.lastIndexOf('http://', 0) === 0;
    var isWs = url.lastIndexOf('ws://', 0) === 0;
    if (!isHttp && !isWs) return url;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return url;
    }
    // Ya apunta a nuestro propio origen (caso preview servido por http en dev local): nada que hacer.
    if (parsed.host === window.location.host) return url;
    rewritten++;
    var tail = parsed.pathname + parsed.search + parsed.hash;
    if (isWs) return (secure ? 'wss://' : 'ws://') + window.location.host + tail;
    return origin + tail;
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string') return nativeFetch.call(this, rewrite(input), init);
      // Request object: sólo lo reconstruimos si de verdad hay que reescribirlo (clonar un Request
      // con body ya consumido rompe; si la URL no cambia, no lo tocamos).
      if (input && typeof input.url === 'string') {
        var next = rewrite(input.url);
        if (next !== input.url) return nativeFetch.call(this, new Request(next, input), init);
      }
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(url);
    return nativeOpen.apply(this, args);
  };

  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    var PatchedWebSocket = function (url, protocols) {
      return protocols === undefined
        ? new NativeWebSocket(rewrite(url))
        : new NativeWebSocket(rewrite(url), protocols);
    };
    PatchedWebSocket.prototype = NativeWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      PatchedWebSocket[k] = NativeWebSocket[k];
    });
    window.WebSocket = PatchedWebSocket;
  }

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return data === undefined ? nativeBeacon(rewrite(url)) : nativeBeacon(rewrite(url), data);
    };
  }

  // Superficie de diagnóstico: si el preview "no trae datos", esto dice si el shim llegó a actuar.
  window.__fluxoPreviewShim = {
    origin: origin,
    rewrite: rewrite,
    get rewritten() {
      return rewritten;
    },
  };
  console.info('[fluxo-preview] shim de emulador activo — el tráfico http del SDK sale por ' + origin);
})();
