/*
  Ripple Distortion — vanilla WebGL port of reactbits.dev/animations/ripple-distortion
  createRipple(canvas, source, options) -> { setSource(imgOrCanvas), destroy() }
  The canvas is sized to its own CSS box; pointer input is read from window so
  the effect keeps working over text and buttons layered above it.
*/
(function (global) {
  var MAX_WAVES = 100, START_SCALE = 1.5, LIFE_CONSTANT = Math.log(500);
  var QUALITY_SCALE = { low: 0.4, medium: 0.7, high: 1 };

  var DEFAULTS = {
    brushSize: 155, strength: 0.2, swirl: 1, rings: 2, spread: 5, fade: 3,
    spacing: 5, dispersion: 1, glint: 0, tint: '#a855f7', tintAmount: 0.1,
    grayscale: false, highlightColor: '#ffffff', trigger: 'hover',
    clickStrength: 2, quality: 'low',
    ambient: true,      // drifting auto-ripple while nobody is interacting
    ambientDelay: 2500  // ms of inactivity before ambient kicks in
  };

  function hexToRGB(hex) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(c, 16);
    return isNaN(n) ? [1, 1, 1] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  var WAVE_VS = [
    'precision highp float;',
    'attribute vec2 position;',
    'uniform vec2 uOffset; uniform vec2 uScale;',
    'varying vec2 vUv;',
    'void main(){ vUv = position * 0.5 + 0.5; gl_Position = vec4(uOffset + position * uScale, 0.0, 1.0); }'
  ].join('\n');

  var WAVE_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform float uRings; uniform float uOpacity;',
    'const float PI = 3.141592653589793;',
    'const float EDGE = 0.006737947;',
    'void main(){',
    '  vec2 p = vUv * 2.0 - 1.0; float r = dot(p, p);',
    '  if (r > 1.0) discard;',
    '  float brush = (exp(-r * 5.0) - EDGE) / (1.0 - EDGE);',
    '  brush *= 0.55 + 0.45 * cos(sqrt(r) * PI * 2.0 * uRings);',
    '  gl_FragColor = vec4(vec3(brush * uOpacity * uOpacity), 1.0);',
    '}'
  ].join('\n');

  var SCREEN_VS = [
    'precision highp float;',
    'attribute vec2 position;',
    'varying vec2 vUv;',
    'void main(){ vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }'
  ].join('\n');

  var COMPOSITE_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTexture; uniform sampler2D uDisplacement;',
    'uniform vec2 uResolution; uniform vec2 uTextureSize; uniform vec2 uTexel;',
    'uniform vec3 uTint; uniform vec3 uHighlight;',
    'uniform float uStrength, uSwirl, uDispersion, uGlint, uTintAmount, uGrayscale;',
    'const float TAU = 6.283185307179586;',
    'vec2 coverUV(vec2 uv){',
    '  vec2 safe = max(uTextureSize, vec2(1.0));',
    '  vec2 s = uResolution / safe;',
    '  vec2 scaled = safe * max(s.x, s.y);',
    '  vec2 off = (uResolution - scaled) * 0.5;',
    '  return (uv * uResolution - off) / scaled;',
    '}',
    'void main(){',
    '  float amount = texture2D(uDisplacement, vUv).r;',
    '  vec2 base = coverUV(vUv);',
    '  float theta = amount * uSwirl * TAU;',
    '  vec2 push = vec2(sin(theta), cos(theta)) * amount * uStrength;',
    '  vec3 color;',
    '  if (uDispersion > 0.001) {',
    '    float split = uDispersion * 0.25;',
    '    color.r = texture2D(uTexture, base + push * (1.0 + split)).r;',
    '    color.g = texture2D(uTexture, base + push).g;',
    '    color.b = texture2D(uTexture, base + push * (1.0 - split)).b;',
    '  } else { color = texture2D(uTexture, base + push).rgb; }',
    '  if (uGrayscale > 0.001) color = mix(color, vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), uGrayscale);',
    '  if (uTintAmount > 0.001) color = mix(color, color * uTint * 1.9, clamp(amount * 1.6, 0.0, 1.0) * uTintAmount);',
    '  if (uGlint > 0.001) {',
    '    float ex = texture2D(uDisplacement, vUv + vec2(uTexel.x, 0.0)).r - texture2D(uDisplacement, vUv - vec2(uTexel.x, 0.0)).r;',
    '    float ey = texture2D(uDisplacement, vUv + vec2(0.0, uTexel.y)).r - texture2D(uDisplacement, vUv - vec2(0.0, uTexel.y)).r;',
    '    vec3 n = normalize(vec3(-ex * 26.0, -ey * 26.0, 1.0));',
    '    vec3 l = normalize(vec3(-0.35, 0.55, 1.0));',
    '    float raw = pow(max(dot(n, l), 0.0), 22.0);',
    '    float flatSpec = pow(max(l.z, 0.0), 22.0);',
    '    color += uHighlight * clamp((raw - flatSpec) / max(1.0 - flatSpec, 0.0001), 0.0, 1.0) * uGlint;',
    '  }',
    '  gl_FragColor = vec4(color, 1.0);',
    '}'
  ].join('\n');

  function createRipple(canvas, source, options) {
    var CFG = {};
    for (var k in DEFAULTS) CFG[k] = DEFAULTS[k];
    for (var k2 in options || {}) CFG[k2] = options[k2];

    var reduceMotion = global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) return null;

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    function program(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'position');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p: p, u: u };
    }

    var waveProg, compProg;
    try {
      waveProg = program(WAVE_VS, WAVE_FS);
      compProg = program(SCREEN_VS, COMPOSITE_FS);
    } catch (e) { console.warn('[ripple]', e); return null; }

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    function makeTex() {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    var imageTex = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    var texSize = [1, 1];

    function setSource(src) {
      if (!src) return;
      gl.bindTexture(gl.TEXTURE_2D, imageTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      texSize = [src.naturalWidth || src.width || 1, src.naturalHeight || src.height || 1];
      drawNow();
    }

    var dispTex = makeTex();
    var fbo = gl.createFramebuffer();
    var fieldW = 2, fieldH = 2, width = 1, height = 1;
    var disposed = false, raf = 0, prevT = 0, visible = true, idleFrames = 0;

    var waves = [];
    for (var i = 0; i < MAX_WAVES; i++) waves.push({ x: 0, y: 0, scale: START_SCALE, target: START_SCALE, size: 1, opacity: 0 });
    var current = 0;

    function resize() {
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      width = Math.max(1, canvas.clientWidth);
      height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      var s = QUALITY_SCALE[CFG.quality] || 1;
      fieldW = Math.max(2, Math.round(width * s));
      fieldH = Math.max(2, Math.round(height * s));
      gl.bindTexture(gl.TEXTURE_2D, dispTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldW, fieldH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dispTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      drawNow(); // resizing clears the canvas
    }
    var ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function addWave(x, y, power) {
      if (reduceMotion) return;
      var w = waves[current];
      current = (current + 1) % MAX_WAVES;
      w.x = x; w.y = y;
      w.scale = START_SCALE * power;
      w.target = START_SCALE * Math.max(1, CFG.spread) * power;
      w.size = Math.max(1, CFG.brushSize);
      w.opacity = 1;
      wake();
    }

    function localPoint(cx, cy) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
      return [cx - r.left, r.height - (cy - r.top)];
    }

    var prevX = 0, prevY = 0, lastInput = -Infinity;
    function emitAt(x, y) {
      var step = Math.max(1, CFG.spacing);
      if (Math.abs(x - prevX) > step || Math.abs(y - prevY) > step) {
        addWave(x, y, 1);
        prevX = x; prevY = y;
      }
    }
    function onMove(e) {
      lastInput = performance.now();
      if (CFG.trigger === 'click') return;
      var p = localPoint(e.clientX, e.clientY);
      if (p) emitAt(p[0], p[1]);
    }
    function onDown(e) {
      lastInput = performance.now();
      if (CFG.trigger === 'hover') return;
      var p = localPoint(e.clientX, e.clientY);
      if (p) addWave(p[0], p[1], Math.max(1, CFG.clickStrength));
    }
    global.addEventListener('pointermove', onMove, { passive: true });
    global.addEventListener('pointerdown', onDown, { passive: true });

    // Ambient: slow Lissajous drift so the frame is alive on touch / idle screens
    function ambientTick(now) {
      if (!CFG.ambient || reduceMotion || now - lastInput < CFG.ambientDelay) return false;
      var t = now / 1000;
      var x = width * (0.5 + 0.34 * Math.sin(t * 0.37) * Math.cos(t * 0.11));
      var y = height * (0.5 + 0.30 * Math.sin(t * 0.23 + 1.3));
      emitAt(x, y);
      return true;
    }

    var tint = hexToRGB(CFG.tint), hl = hexToRGB(CFG.highlightColor);

    function frame(now) {
      raf = 0;
      var dt = prevT ? Math.min(0.05, (now - prevT) / 1000) : 0;
      prevT = now;
      var ambientOn = ambientTick(now);
      var growth = 1 - Math.exp(-dt * 1.09);
      var decay = Math.exp((-dt * LIFE_CONSTANT) / Math.max(0.15, CFG.fade));

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, fieldW, fieldH);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(waveProg.p);
      gl.uniform1f(waveProg.u.uRings, CFG.rings);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      var active = 0;
      for (var i = 0; i < MAX_WAVES; i++) {
        var w = waves[i];
        if (w.opacity <= 0) continue;
        w.opacity *= decay;
        w.scale += (w.target - w.scale) * growth;
        if (w.opacity < 0.002) { w.opacity = 0; continue; }
        active++;
        var half = (w.scale * w.size) / 2;
        gl.uniform2f(waveProg.u.uOffset, (w.x / width) * 2 - 1, (w.y / height) * 2 - 1);
        gl.uniform2f(waveProg.u.uScale, (half / width) * 2, (half / height) * 2);
        gl.uniform1f(waveProg.u.uOpacity, w.opacity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(compProg.p);
      var u = compProg.u;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imageTex); gl.uniform1i(u.uTexture, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dispTex); gl.uniform1i(u.uDisplacement, 1);
      gl.uniform2f(u.uResolution, width, height);
      gl.uniform2f(u.uTextureSize, texSize[0], texSize[1]);
      gl.uniform2f(u.uTexel, 1 / fieldW, 1 / fieldH);
      gl.uniform3fv(u.uTint, tint);
      gl.uniform3fv(u.uHighlight, hl);
      gl.uniform1f(u.uStrength, CFG.strength);
      gl.uniform1f(u.uSwirl, CFG.swirl);
      gl.uniform1f(u.uDispersion, CFG.dispersion);
      gl.uniform1f(u.uGlint, CFG.glint);
      gl.uniform1f(u.uTintAmount, CFG.tintAmount);
      gl.uniform1f(u.uGrayscale, CFG.grayscale ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.activeTexture(gl.TEXTURE0);

      // Sleep when idle; ambient mode keeps the loop alive
      idleFrames = active || ambientOn ? 0 : idleFrames + 1;
      if (visible && idleFrames < 3) raf = requestAnimationFrame(frame);
      else prevT = 0;
    }
    // Render synchronously (don't wait for rAF, which is paused in hidden tabs)
    function drawNow() {
      if (disposed) return;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      frame(performance.now());
    }
    function wake() {
      idleFrames = 0;
      if (!raf && visible && !disposed) raf = requestAnimationFrame(frame);
    }

    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) wake();
    });
    io.observe(canvas);

    // Ambient needs a periodic nudge after going idle
    var ambientTimer = CFG.ambient && !reduceMotion ? setInterval(wake, 500) : 0;
    document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });

    resize();
    if (source) setSource(source);

    return {
      setSource: setSource,
      destroy: function () {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        clearInterval(ambientTimer);
        ro.disconnect(); io.disconnect();
        global.removeEventListener('pointermove', onMove);
        global.removeEventListener('pointerdown', onDown);
        var ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    };
  }

  global.createRipple = createRipple;
})(window);
