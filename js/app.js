/**
 * app.js — 启动引导：Store 初始化 / 语言切换 / Worker 引擎封装 / 工具函数
 */
(function () {
  'use strict';
  window.LG = window.LG || {};

  // ============ 全局状态 ============
  LG.state = {
    project: null,     // 当前项目（LG.Store.active() 引用）
    mesh: null,        // { positions:Float32Array(mm), indices:Uint32Array|null, faceCount, name, isParametric }
    // 导入模型网格缓存（项目 id → mesh）：导入的 STL/OBJ/STEP 只存在于内存，
    // 切换盘位后需要能原样恢复，刷新页面后才会丢失（仍提示重新导入）。
    meshCache: {},
    lastRun: null      // 最近一次仿真聚合结果（含 params 快照）
  };

  // ============ 引擎封装：Worker 优先，失败自动回退主线程 ============
  var worker = null;
  var workerBroken = false;

  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker('js/engine/raytracer.worker.js?v=12');
      console.info('RayTracer worker ready');
      return worker;
    } catch (e) {
      console.warn('Worker unavailable, main-thread fallback:', e.message);
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function runOnMainThread(meshData, options) {
    return new Promise(function (resolve, reject) {
      try {
        var tracer = new RayTracer(meshData, options);
        // 光线追踪（分批 + 浏览器让步：让主线程能重绘进度条）
        tracer._simulateAsync(options.onProgress || null).then(function (results) {
          try {
            var agg = tracer.aggregate(results, {
              heatmapRes: options.heatmapRes, axisBins: options.axisBins, angleBinDeg: options.angleBinDeg
            });
            var payload = {
              total: results.total, success: results.success, escaped: results.escaped,
              exhausted: results.exhausted, successRate: results.successRate,
              avgOutputIntensity: results.avgOutputIntensity, maxBounces: results.maxBounces,
              ledger: results.ledger, agg: agg, elapsedMs: null, visRays: results.visRays
            };
            if (options.returnSegments) payload.segments = results.segments;
            if (options.returnSpot) payload.hits = results.outputHits;
            resolve(payload);
          } catch (err) { reject(err); }
        }).catch(reject);
      } catch (err) { reject(err); }
    });
  }

  /**
   * 运行仿真（聚合结果）
   * Worker 静默挂起（脚本加载失败 / 无响应）超过看门狗时限 → 终止并永久降级主线程。
   * @returns Promise<payload> payload = {summary..., ledger, agg, elapsedMs, segments?}
   */
  LG.Engine = {
    run: function (meshData, options) {
      var w = getWorker();
      if (!w) return runOnMainThread(meshData, options);

      return new Promise(function (resolve, reject) {
        var settled = false;
        var wd = null;
        var WATCHDOG_MS = 12000;

        function armWatchdog() {
          clearTimeout(wd);
          wd = setTimeout(failover, WATCHDOG_MS,
            new Error('worker silent timeout (no message in ' + WATCHDOG_MS + 'ms)'));
        }
        function failover(err) {
          if (settled) return;
          settled = true;
          clearTimeout(wd);
          w.removeEventListener('message', handler);
          w.removeEventListener('error', failover);
          workerBroken = true;
          try { w.terminate(); } catch (e2) { /* ignore */ }
          if (worker === w) worker = null;
          console.warn('Worker failover → main thread:', err && err.message);
          runOnMainThread(meshData, options).then(resolve, reject);
        }
        function handler(e) {
          var msg = e.data || {};
          if (msg.type === 'progress') {
            armWatchdog();
            if (options.onProgress) options.onProgress(msg.done, msg.total);
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(wd);
          w.removeEventListener('message', handler);
          w.removeEventListener('error', failover);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        }

        w.addEventListener('message', handler);
        w.addEventListener('error', failover);
        armWatchdog();
        var opt = {};
        for (var k in options) if (k !== 'onProgress') opt[k] = options[k];
        try {
          w.postMessage({ meshData: meshData, options: opt });
        } catch (err) {
          failover(err);
        }
      });
    },
    mode: function () { return workerBroken ? 'main' : (getWorker() ? 'worker' : 'main'); },
    /**
     * 刷新当前项目的 LED 灯珠位姿（led.poses 数组，mm 空间）。
     * 触发时机：导入模型几何变更 / 用户拾取或切换入射面 / LED 参数保存。
     * 规则：仅「手动导入模型（非参数化）+ LED 启用 + 已选入射面」时按入射面动态计算
     * （RayTracer.computeLEDPoses：按平面聚类，每个入射平面一颗灯珠，
     *  灯珠置于面前、发射方向对齐法向）；
     * 参数化圆柱等其余场景位姿为 null → 引擎与 Viewer 均回退默认坐标（向后兼容）。
     * led.pose（单数）保留为首位姿的兼容别名。
     */
    refreshLEDPose: function () {
      var p = LG.state.project, mesh = LG.state.mesh;
      if (!p || !p.led) return null;
      var poses = null;
      // 只要 LED 启用 + mesh 已存在 + 已选入射面（不管参数化还是导入模型），都按入射面动态算 pose。
      // 参数化圆柱旧版没有入射面 → mesh.isParametric 且没选面时 pose 为 null，引擎/Viewer 回退默认坐标。
      if (p.led.enabled && mesh && mesh.positions) {
        var beads = (p.beads && p.beads.length) ? p.beads : [{ input: (p.faces.input||[]), output: (p.faces.output||[]) }];
        var allPoses = [];
        try {
          beads.forEach(function (bead) {
            if (bead.on === false) return;   // 未勾选的灯珠：不生成位姿 → 不渲染、不参与仿真
            if (bead.input && bead.input.length > 0) {
              var bp = RayTracer.computeLEDPose(mesh.positions, mesh.indices, bead.input);
              if (bp) allPoses.push(bp);
            }
          });
        } catch (e) {
          console.warn('LED pose computation failed:', e);
        }
        poses = allPoses.length ? allPoses : null;
      }
      // 绕光轴（pose.z）旋转：把 rotZ 角度合成进 pose.x / pose.y 基向量
      // 用户旋转只改变灯珠发光方向的局部朝向，不改变灯珠位置和主光轴方向
      var rotDeg = +(p.led && p.led.rotZ) || 0;
      if (poses && rotDeg) {
        var rotRad = rotDeg * Math.PI / 180;
        var cs = Math.cos(rotRad), sn = Math.sin(rotRad);
        for (var ri = 0; ri < poses.length; ri++) {
          var ps = poses[ri];
          // 绕 z 轴旋转 x 基向量：x' = x·cos + y·sin, y' = -x·sin + y·cos
          var nx0 = ps.x[0] * cs + ps.y[0] * sn;
          var nx1 = ps.x[1] * cs + ps.y[1] * sn;
          var nx2 = ps.x[2] * cs + ps.y[2] * sn;
          var ny0 = -ps.x[0] * sn + ps.y[0] * cs;
          var ny1 = -ps.x[1] * sn + ps.y[1] * cs;
          var ny2 = -ps.x[2] * sn + ps.y[2] * cs;
          ps.x = [nx0, nx1, nx2];
          ps.y = [ny0, ny1, ny2];
        }
      }
      var cur = p.led.poses || null;
      var same = (poses === cur) || (poses && cur && poses.length === cur.length && poses.every(function (np, i) {
        var cp = cur[i];
        return cp && np.pos[0] === cp.pos[0] && np.pos[1] === cp.pos[1] && np.pos[2] === cp.pos[2] &&
          np.z[0] === cp.z[0] && np.z[1] === cp.z[1] && np.z[2] === cp.z[2] &&
          np.x[0] === cp.x[0] && np.x[1] === cp.x[1] && np.x[2] === cp.x[2];
      }));
      if (!same) {
        p.led = Object.assign({}, p.led, {
          poses: poses,
          pose: (poses && poses.length === 1) ? poses[0] : null
        });
        LG.Store.updateActive({ led: p.led });
      }
      LG.Viewer.setLED(p.led);
      return poses;
    }
  };

  // ============ 工具 ============
  LG.fmt = function (v, digits) {
    if (v == null || isNaN(v)) return '-';
    return Number(v).toFixed(digits == null ? 3 : digits);
  };
  LG.esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var statusTimer = null;
  LG.status = function (msg) {
    var bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.textContent = msg;
    bar.classList.add('show');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { bar.classList.remove('show'); }, 3000);
  };
  LG.download = function (filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  // ============ 3D 零件文件解析（STL / OBJ / STEP）============
  // 「模型配置 → 文件导入」与「拖到盘面导入」共用这一套解析：
  // 解析后统一做 RayTracer.fixWinding（焊接重复顶点 + 统一绕向），避免两套行为。
  function loadScriptOnce(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src; s.onload = onload;
    s.onerror = onerror || function () { LG.status('Failed to load: ' + src); };
    document.head.appendChild(s);
  }

  /**
   * 解析零件文件。
   * @param {File} file
   * @param {function(Error, Object)} cb 成功回调 cb(null, {positions, indices, name, welded, flipped})
   */
  LG.parsePartFile = function (file, cb) {
    cb = cb || function () {};
    var name = (file && file.name) || '';
    var ext = name.split('.').pop().toLowerCase();

    function finish(positions, indices) {
      try {
        var fixed = RayTracer.fixWinding(
          new Float32Array(positions),
          (indices && indices.length) ? new Uint32Array(indices) : null);
        cb(null, {
          positions: fixed.positions, indices: fixed.indices, name: name,
          welded: fixed.welded || 0, flipped: fixed.flipped || 0
        });
      } catch (err) { cb(err); }
    }

    if (ext === 'stl') {
      file.arrayBuffer().then(function (buf) {
        var geo = new THREE.STLLoader().parse(buf);
        var pa = geo && geo.attributes && geo.attributes.position;
        if (!pa) { cb(new Error('empty stl')); return; }
        finish(pa.array, geo.index ? geo.index.array : null);
      }).catch(cb);
    } else if (ext === 'obj') {
      file.text().then(function (text) {
        var obj = new THREE.OBJLoader().parse(text);
        var geo = obj.children[0] ? obj.children[0].geometry : null;
        var pa = geo && geo.attributes && geo.attributes.position;
        if (!pa) { cb(new Error('empty obj')); return; }
        finish(pa.array, geo.index ? geo.index.array : null);
      }).catch(cb);
    } else if (ext === 'step' || ext === 'stp') {
      parseSTEP(file, cb, finish);
    } else {
      cb(new Error('unsupported: ' + ext));
    }
  };

  /** STEP 依赖 occt-import-js（CDN + WASM），多面片合并后交给 finish 统一修复绕向 */
  function parseSTEP(file, cb, finish) {
    var occtCdn = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/';
    loadScriptOnce(occtCdn + 'occt-import-js.js', function () {
      if (typeof occtimportjs === 'undefined') { cb(new Error('STEP parser failed to load')); return; }
      occtimportjs({ locateFile: function (p) { return occtCdn + p; } }).then(function (occt) {
        file.arrayBuffer().then(function (buf) {
          var result = occt.ReadStepFile(new Uint8Array(buf), null);
          if (!result || !result.success || !(result.meshes || []).length) {
            cb(new Error('empty step')); return;
          }
          var positions = [], indices = [], vOffset = 0;
          for (var mi = 0; mi < result.meshes.length; mi++) {
            var mm = result.meshes[mi], pa = mm.attributes.position.array;
            for (var pi = 0; pi < pa.length; pi++) positions.push(pa[pi]);
            if (mm.index) {
              var ia = mm.index.array;
              for (var ii = 0; ii < ia.length; ii++) indices.push(ia[ii] + vOffset);
            } else {
              for (var vi = 0; vi < pa.length / 3; vi += 3) {
                indices.push(vi + vOffset, vi + 1 + vOffset, vi + 2 + vOffset);
              }
            }
            vOffset += pa.length / 3;
          }
          finish(positions, indices);
        }).catch(cb);
      }).catch(cb);
    }, function () { cb(new Error('Failed to load STEP parser from CDN')); });
  }

  // ============ 网格持久化辅助 ============
  // Float32Array / Uint32Array ↔ JSON 数组（localStorage / 导出 JSON 都用普通数组，能被 JSON.stringify 直接序列化）。
  // 超过 MAX_BYTES_THRESHOLD 的大网格不持久化（序列化后体积膨胀 ~4x，避免撑爆 5MB localStorage），只保存在内存 meshCache。
  // 经验阈值：256KB ≈ 64K 顶点（positions），覆盖绝大多数 STL/STEP 零件；超阈值的超大模型刷新后需重新导入。
  var MAX_MESH_JSON_BYTES = 256 * 1024;

  function meshToJSON(positions, indices) {
    if (!positions || !positions.length) return null;
    var posArr = Array.prototype.slice.call(positions);  // Float32Array → number[]
    var idxArr = indices && indices.length ? Array.prototype.slice.call(indices) : null;
    var approxBytes = posArr.length * 8 + (idxArr ? idxArr.length * 6 : 0);  // 粗略估算 JSON 后 ~8 字节/顶点、~6 字节/索引
    if (approxBytes > MAX_MESH_JSON_BYTES) return null;
    return { positions: posArr, indices: idxArr || null };
  }

  function meshFromJSON(raw) {
    if (!raw || !raw.positions || !raw.positions.length) return null;
    return {
      positions: new Float32Array(raw.positions),
      indices: raw.indices && raw.indices.length ? new Uint32Array(raw.indices) : null
    };
  }

  /** 把网格数据（positions/indices）存入 geometry._mesh，并同步写入 meshCache */
  function persistMeshToProject(projId, parsed) {
    var jmesh = meshToJSON(parsed.positions, parsed.indices);
    var proj = LG.Store.get(projId);
    if (!proj) return;
    // meshCache 永远保留（内存中无大小限制）
    LG.state.meshCache[projId] = {
      positions: parsed.positions, indices: parsed.indices, name: parsed.name
    };
    // geometry._mesh 只在阈值内才写，避免 localStorage 爆掉
    var geomPatch = { geometry: Object.assign({}, proj.geometry, { fileName: parsed.name }) };
    if (jmesh) geomPatch.geometry._mesh = jmesh;
    else if (proj.geometry && proj.geometry._mesh) geomPatch.geometry._mesh = null;  // 大模型清空旧缓存
    LG.Store.update(projId, geomPatch);
  }

  /** 把项目里保存的网格恢复到 meshCache（刷新页面后从 geometry._mesh 兜底） */
  function restoreMeshFromProject(proj) {
    if (!proj || !proj.geometry || !proj.geometry._mesh) return false;
    if (LG.state.meshCache[proj.id]) return true;  // 已有内存缓存就不重复反序列化
    var m = meshFromJSON(proj.geometry._mesh);
    if (!m) return false;
    LG.state.meshCache[proj.id] = {
      positions: m.positions, indices: m.indices, name: proj.geometry.fileName || 'imported'
    };
    return true;
  }

  /**
   * 把解析结果导入指定项目（等价「文件导入」的落库 + 视图同步）：
   * geometry.fileName、网格缓存 LG.state.meshCache、网格持久化 geometry._mesh（可刷新恢复）、
   * 端面自动识别、LED 位姿刷新。
   * 只有该项目正在 3D 视图中显示时才重建网格；否则只写缓存，切到该项目时由页面层恢复。
   */
  LG.importIntoProject = function (projId, parsed) {
    if (!projId || !parsed || !parsed.positions) return false;
    var proj = LG.Store.get(projId);
    if (!proj) return false;
    persistMeshToProject(projId, parsed);

    var cur = LG.state.project;
    if (!cur || cur.id !== projId || !LG.Viewer || !LG.Viewer.isReady()) return true;

    LG.Viewer.setGeometryData(parsed.positions, parsed.indices, parsed.name);
    var auto = LG.Viewer.autoEndCaps();
    LG.Store.update(projId, { faces: { input: auto.input, output: auto.output } });
    LG.state.mesh = {
      positions: parsed.positions, indices: parsed.indices,
      faceCount: LG.Viewer.faceCount(), name: parsed.name, isParametric: false
    };
    LG.Viewer.setFaceHighlights(auto.input, auto.output);
    LG.Engine.refreshLEDPose();
    if (parsed.welded > 0 || parsed.flipped > 0) {
      LG.status(LG.t('model.msg.fixed', parsed.welded, parsed.flipped));
    }
    return true;
  };

  // 暴露给外部模块（model.js / home.js / importJSON 后）
  LG.restoreMeshFromProject = restoreMeshFromProject;

  /** 去掉扩展名，作为新项目名（零件名） */
  function stripExt(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }

  /**
   * 文件拖放到盘面：默认「新增零件」到目标盘（共享 plateId），不覆盖已有零件。
   * 目标盘就是当前盘且当前项目还没有几何时，第一个文件直接补进当前项目（与文件导入完全一致）。
   */
  function handleFileDrop(files, projectId) {
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var ext = files[i].name.split('.').pop().toLowerCase();
      if (ext === 'stl' || ext === 'obj' || ext === 'step' || ext === 'stp') list.push(files[i]);
    }
    if (!list.length) { LG.status(LG.t('drop.badtype')); return; }

    var cur = LG.state.project;
    var target = projectId ? LG.Store.get(projectId) : null;
    var targetPlateId = target ? LG.Store.plateIdOf(target) : '';
    var curPlateId = cur ? LG.Store.plateIdOf(cur) : '';
    var intoCurrent = !!(cur && targetPlateId && curPlateId === targetPlateId &&
      !(cur.geometry && cur.geometry.fileName));
    var usedCurrent = false;

    var idx = 0, done = 0, fail = 0, lastId = null, lastParsed = null, names = [];

    function next() {
      if (idx >= list.length) { finish(); return; }
      var file = list[idx++];
      LG.status('Loading ' + file.name + ' ...');
      LG.parsePartFile(file, function (err, parsed) {
        if (err || !parsed) { fail++; next(); return; }
        var projId;
        if (intoCurrent && !usedCurrent) {
          usedCurrent = true;
          projId = cur.id;                       // 复用当前项目（与文件导入一致）
        } else {
          var np = LG.Store.create(stripExt(file.name));
          projId = np.id;
          LG.Store.update(np.id, {
            plateId: targetPlateId || np.id,     // 盘外拖入 → 各自独立成盘
            geometry: Object.assign({}, np.geometry, { fileName: file.name }),
            faces: { input: [], output: [] }
          });
        }
        LG.importIntoProject(projId, parsed);
        lastId = projId; lastParsed = parsed;
        names.push(file.name); done++;
        next();
      });
    }

    function finish() {
      if (!done) {
        LG.status(LG.t(fail ? 'model.msg.fail' : 'drop.badtype'));
        return;
      }
      var last = LG.Store.get(lastId);
      if (last) {
        LG.Store.setActive(lastId);
        LG.state.project = last;
        // 最后导入的零件可能不是当前视图里的项目：同步到共享 Viewer，
        // 避免重渲染后仍显示上一个项目的网格
        if (lastParsed) LG.importIntoProject(lastId, lastParsed);
      }
      if (LG.Router.current() === 'model') LG.Router.rerender();
      LG.status(LG.t('drop.ok', done, names.join('、')));
    }

    next();
  }

  // ============ 顶栏导航小图标 ============
  var NAV_ICONS = {
    'home': '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
    'model': '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5L12 12l8-4.5"/><path d="M12 12v9"/>',
    'simulate': '<circle cx="12" cy="12" r="9" stroke-dasharray="3 2"/><path d="M8 8l4 4-4 4"/><path d="M13 8l4 4-4 4"/>',
    'analysis': '<path d="M3 20h18"/><path d="M6 16V9"/><path d="M10 16V5"/><path d="M14 16v-8"/><path d="M18 16v-4"/>',
    'report': '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/><path d="M9 13h6M9 17h6"/><path d="M9 9h4"/>',
    'options': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
  };
  var NAV_ROUTE_KEY = {
    '#/home': 'home', '#/model': 'model', '#/simulate': 'simulate',
    '#/analysis': 'analysis', '#/report': 'report'
  };
  var _navDecorated = false;
  function decorateNavIcons() {
    if (_navDecorated) return;
    _navDecorated = true;
    var items = document.querySelectorAll('#main-nav .nav-item');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (el.querySelector('.nav-ic')) continue;
      var route = el.getAttribute('href');
      var key = NAV_ROUTE_KEY[route];
      if (!key) {
        // 选项按钮（无 href）
        if (el.id === 'opts-btn') key = 'options';
      }
      if (!key || !NAV_ICONS[key]) continue;
      el.insertAdjacentHTML('afterbegin',
        '<svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        NAV_ICONS[key] + '</svg>');
    }
  }
  LG.decorateNavIcons = decorateNavIcons;

  // ============ 卡片标题功能小图标（线性风格，参考切片软件配置面板） ============
  // 图标 = 24×24 线性描边（stroke=currentColor），通过 i18n key 映射到标题文字，
  // 由路由渲染后统一注入，避免在 28 处卡片标题里重复写 SVG。
  var ICONS = {
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/><path d="M12 11v6m0 0l-2.5-2.5M12 17l2.5-2.5"/>',
    // 材料选型 — 塑料板材 / 聚合物（水滴改为此）
    matlib: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M3 11h18" stroke-dasharray="2.5 2"/><path d="M7 6v12M12 6v12M17 6v12" stroke-opacity=".35"/>',
    surface: '<path d="M3 7c2 2 4-2 6 0s4 2 6 0 3-1.5 6 0"/><path d="M3 12c2 2 4-2 6 0s4 2 6 0 3-1.5 6 0"/><path d="M3 17c2 2 4-2 6 0s4 2 6 0 3-1.5 6 0"/>',
    ledlib: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8V16h7.2v-2.2A6 6 0 0 0 12 3z"/>',
    env: '<path d="M4 20V6h8v14"/><path d="M16 20V10h4v10"/><path d="M2 20h20"/>',
    goals: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    mode: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
    faces: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/><path d="M4 9h16" stroke-width="2.4"/><path d="M9 4v5"/>',
    adv: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    threshold: '<path d="M4 17a8 8 0 0 1 16 0"/><path d="M12 17l4.5-5.5"/><path d="M4 20h16"/>',
    compare: '<rect x="4" y="9" width="6" height="11" rx="1"/><rect x="14" y="4" width="6" height="16" rx="1"/>',
    spot: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    heat: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1" opacity=".45"/><rect x="4" y="13" width="7" height="7" rx="1" opacity=".45"/><rect x="13" y="13" width="7" height="7" rx="1" opacity=".25"/>',
    tolerance: '<path d="M5 12h14"/><path d="M12 4v6m0 0L9.5 7.5M12 10l2.5-2.5"/><path d="M9 18h6"/>',
    axis: '<path d="M4 3v17h17"/><path d="M7 16l4-5 3 3 5-6"/>',
    polar: '<circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/><path d="M12 4c2.6 3 2.6 5 0 8-2.6-3-2.6-5 0-8z"/><path d="M20 12c-3 2.6-5 2.6-8 0 3-2.6 5-2.6 8 0z"/><path d="M12 20c-2.6-3-2.6-5 0-8 2.6 3 2.6 5 0 8z"/><path d="M4 12c3-2.6 5-2.6 8 0-3 2.6-5 2.6-8 0z"/>',
    checklist: '<path d="M3 6l2 2 3-3"/><path d="M3 13l2 2 3-3"/><path d="M3 20l2 2 3-3"/><path d="M12 7h9M12 14h9M12 21h9"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/><path d="M9 13h6M9 17h6"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4.2l3 1.8"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>'
  };
  // i18n key → 图标名
  var ICON_KEY = {
    'model.file.title': 'file', 'model.matlib': 'matlib', 'model.surface': 'surface',
    'model.ledlib': 'ledlib', 'model.env': 'env', 'model.goals': 'goals',
    'sim.mode.card': 'mode', 'sim.faces': 'faces', 'sim.adv': 'adv',
    'ana.src': 'db', 'ana.m.th': 'threshold', 'ana.compare': 'compare',
    'ana.spot': 'spot', 'ana.heat': 'heat', 'ana.tol.title': 'tolerance',
    'ana.axis': 'axis', 'ana.polar': 'polar',
    'rpt.opt': 'checklist', 'rpt.generate': 'doc', 'rpt.history': 'history',
    'model.viewer': 'cube',
    'spot.src': 'db', 'spot.proj': 'spot', 'spot.export': 'doc',
    'spot.heat': 'heat', 'spot.mode.sep': 'spot', 'spot.disp': 'spot'
  };
  var _titleList = null;   // [[标题文字, 图标名], ...]，按文字长度降序
  var _titleMap = null;

  function buildTitleMap() {
    var dict = LG.I18N && LG.I18N.dict;
    if (!dict || !dict.zh) return;
    _titleList = [];
    _titleMap = {};
    for (var k in ICON_KEY) {
      if (!dict.zh[k] || !ICONS[ICON_KEY[k]]) continue;
      var zh = String(dict.zh[k]).trim();
      var en = String((dict.en && dict.en[k]) || '').trim();
      _titleMap[zh] = ICON_KEY[k];
      if (en) _titleMap[en] = ICON_KEY[k];
      _titleList.push([zh, ICON_KEY[k]]);
      if (en) _titleList.push([en, ICON_KEY[k]]);
    }
    _titleList.sort(function (a, b) { return b[0].length - a[0].length; });
  }

  /** 给容器内的卡片标题补上功能小图标（幂等，可重复调用） */
  function decorateIcons(root) {
    if (!_titleMap) buildTitleMap();
    if (!_titleMap) return;
    var scope = root || document;
    var titles = scope.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      var el = titles[i];
      if (el.querySelector('.card-ic')) continue;
      var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      var icon = _titleMap[txt];
      if (!icon) {
        // 标题后附带按钮等额外文字时用前缀匹配（取最长命中）
        for (var j = 0; j < _titleList.length; j++) {
          if (txt.indexOf(_titleList[j][0]) === 0) { icon = _titleList[j][1]; break; }
        }
      }
      if (!icon) continue;
      el.insertAdjacentHTML('afterbegin',
        '<svg class="card-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        ICONS[icon] + '</svg>');
    }
  }
  LG.decorateIcons = decorateIcons;

  // ============ 启动 ============
  function boot() {
    decorateNavIcons();   // 顶栏导航小图标
    var project = LG.Store.ensureProject();
    if (LG.Store.list().length === 1 && project.records.length === 0) {
      LG.status(LG.I18N.t('status.noProject'));
    }
    LG.state.project = project;

    // 启动时把所有项目的持久化网格恢复到内存 meshCache（刷新页面后仍可预览 & 重新打开）
    var list = LG.Store.list();
    for (var i = 0; i < list.length; i++) restoreMeshFromProject(list[i]);

    // 文件拖放：STL/OBJ/STEP 拖到盘面 → 新增零件（与目标盘共享 plateId）
    LG.Viewer.onFilesDrop(handleFileDrop);

    // 语言切换
    var sw = document.getElementById('lang-switch');
    sw.addEventListener('click', function (e) {
      var btn = e.target.closest('.lang-btn');
      if (btn) LG.I18N.setLang(btn.getAttribute('data-lang'));
    });
    LG.I18N.applyI18n(document);
    LG.status(LG.I18N.t('status.ready'));
    window.addEventListener('lg:lang', function () { LG.Router.rerender(); });

    // 路由
    LG.Router.register('home', LG.Modules.home);
    LG.Router.register('model', LG.Modules.model);
    LG.Router.register('simulate', LG.Modules.simulate);
    LG.Router.register('analysis', LG.Modules.analysis);
    LG.Router.register('spot', LG.Modules.spot);
    LG.Router.register('report', LG.Modules.report);
    LG.Router.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
