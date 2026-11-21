// Where the FoldPass API lives. Edit this line to point the site at your server.
window.FOLDPASS_API = "";

// No API URL was set at build time: tell visitors instead of failing silently.
document.addEventListener('DOMContentLoaded', function () {
  var main = document.querySelector('main');
  if (!main) return;
  var p = document.createElement('p');
  p.className = 'notice err';
  p.textContent = 'This copy of FoldPass is not connected to a FoldPass server yet, so the CAPTCHA and live data will not load. Set the server URL in config.js.';
  main.prepend(p);
});
