/*! FoldPass SDK loader: classic <script> entry point.
 *
 *   <script src="https://foldpass-tanda.fly.dev/sdk/foldpass.js" async defer></script>
 *   <div class="foldpass" data-sitekey="demo-site-key" data-callback="onFolded"></div>
 *
 * Exposes window.FoldPass. Every method returns a Promise because the SDK
 * module loads asynchronously:
 *   FoldPass.ready()                     -> Promise<FoldPass>
 *   FoldPass.render(el, options)         -> Promise<widget>
 *   FoldPass.execute({ siteKey })        -> Promise<token>      (invisible)
 *   FoldPass.volunteer(options)          -> Promise<controller> (opt-in donation)
 *
 * Script URL options: ?render=explicit (skip auto-render), ?onload=fnName.
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.src) {
    console.error('[FoldPass] load foldpass.js with a <script src>; it uses its own URL to find the API host.');
    return;
  }
  var src = new URL(script.src);
  var mod = import(new URL('foldpass.esm.js', src).href).then(function (m) {
    return m.default;
  });

  function call(name) {
    return function () {
      var args = arguments;
      return mod.then(function (fp) {
        return fp[name].apply(fp, args);
      });
    };
  }

  var api = {
    ready: function (cb) {
      return mod.then(function (fp) {
        if (cb) cb(fp);
        return fp;
      });
    },
    render: call('render'),
    execute: call('execute'),
    solve: call('solve'),
    volunteer: call('volunteer'),
    autoRender: call('autoRender'),
  };
  window.FoldPass = api;

  mod.then(
    function (fp) {
      api.version = fp.version;
      api.host = fp.host;
      function boot() {
        if (src.searchParams.get('render') !== 'explicit') fp.autoRender();
        var onload = src.searchParams.get('onload');
        if (onload && typeof window[onload] === 'function') window[onload](api);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();
    },
    function (err) {
      console.error('[FoldPass] failed to load SDK module:', err);
    },
  );
})();
