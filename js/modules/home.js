/**
 * LG.Modules.home — Home / 启动页 v2
 * 按工作区（Workspace）展示卡片：一个卡片 = 一个 .lgv.json 文件 / 一个开发者工程
 * 点击卡片进入后，工作区内所有盘并排显示在 model 页 3D 场景里（多盘视图）
 */
(function () {
  'use strict';

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-';
    return y + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // ---- 3D 预览 ----
  var offRenderer = null, offScene = null, offCamera = null, offMesh = null;
  function ensureOffscreen() {
    if (offRenderer) return;
    var TH = window.THREE; if (!TH) return;
    offRenderer = new TH.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    offRenderer.setPixelRatio(1);
    offScene = new TH.Scene();
    offScene.background = new TH.Color(0xdcdcdc);
    offCamera = new TH.PerspectiveCamera(45, 1, 0.01, 1000);
    offCamera.position.set(3.2, 2.6, 3.2);
    offCamera.lookAt(0, 0, 0);
    offScene.add(new TH.AmbientLight(0xffffff, 0.85));
    var d1 = new TH.DirectionalLight(0xffffff, 0.75); d1.position.set(5, 10, 7); offScene.add(d1);
    var d2 = new TH.DirectionalLight(0xa8c8ff, 0.25); d2.position.set(-4, -2, -4); offScene.add(d2);
  }
  function disposeOffscreen() {
    if (offMesh) { offScene.remove(offMesh); offMesh.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); offMesh = null; }
  }
  function buildParametricMesh(g) {
    var TH = window.THREE;
    var d1 = Math.max(0.4, +g.d1 || 3), d2 = Math.max(0.4, +g.d2 || d1), L = Math.max(1, +g.length || 30);
    var maxCross = Math.max(d1, d2);
    var scale = Math.min(0.9 / maxCross, 2.0 / L, 1.5);
    if (scale < 0.01) scale = 0.01;
    var geo = new TH.CylinderGeometry(d1 / 2 * scale, d2 / 2 * scale, L * scale, 48, 1, false);
    geo.rotateX(Math.PI / 2); geo.computeBoundingBox();
    var size = new TH.Vector3(), center = new TH.Vector3();
    geo.boundingBox.getSize(size); geo.boundingBox.getCenter(center);
    geo.translate(-center.x, -center.y, -center.z);
    geo.rotateY(-Math.PI / 2); geo.rotateZ(Math.PI / 6);
    var mat = new TH.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: TH.DoubleSide, shininess: 45, specular: 0x0A0A0A
    });
    var mesh = new TH.Mesh(geo, mat);
    mesh.add(new TH.LineSegments(new TH.EdgesGeometry(geo, 8),
      new TH.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.75, depthTest: false })));
    mesh.renderOrder = 1;
    return mesh;
  }
  function buildImportedMesh(proj) {
    var TH = window.THREE;
    var cached = LG.state.meshCache[proj.id];
    if (!cached || !cached.positions || !cached.positions.length) {
      if (LG.restoreMeshFromProject) LG.restoreMeshFromProject(proj);
      cached = LG.state.meshCache[proj.id];
    }
    if (!cached || !cached.positions || !cached.positions.length) return null;
    var geo = new TH.BufferGeometry();
    // 克隆顶点数组：下方的 translate / scale / rotate 会原地改写，
    // 直接引用 meshCache 会把缓存逐次旋转缩放 → 每次切换页面预览角度都不同
    var posClone = (cached.positions instanceof Float32Array) ? cached.positions.slice() : new Float32Array(cached.positions);
    geo.setAttribute('position', new TH.BufferAttribute(posClone, 3));
    if (cached.indices && cached.indices.length) {
      var idxClone = (cached.indices instanceof Uint32Array) ? cached.indices.slice() : new Uint32Array(cached.indices);
      geo.setIndex(new TH.BufferAttribute(idxClone, 1));
    }
    geo.computeVertexNormals(); geo.computeBoundingBox();
    var bb = geo.boundingBox, size = new TH.Vector3(); bb.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z, 0.01);
    var scale = 2.0 / maxDim, center = new TH.Vector3(); bb.getCenter(center);
    geo.translate(-center.x * scale, -center.y * scale, -center.z * scale);
    geo.scale(scale, scale, scale);
    geo.computeBoundingBox();
    var rotY = 0, bb2 = new TH.Box3().setFromBufferAttribute(geo.attributes.position), size2 = new TH.Vector3();
    bb2.getSize(size2);
    if (size2.z > size2.x) rotY = -Math.PI / 2;
    if (rotY) geo.rotateY(rotY);
    geo.rotateZ(Math.PI / 6); geo.computeBoundingBox();
    var mat = new TH.MeshPhongMaterial({
      color: 0x218D83, transparent: true, opacity: 0.5, depthWrite: false,
      side: TH.DoubleSide, shininess: 45, specular: 0x0A0A0A
    });
    var mesh = new TH.Mesh(geo, mat);
    mesh.add(new TH.LineSegments(new TH.EdgesGeometry(geo, 15),
      new TH.LineBasicMaterial({ color: 0x136B63, transparent: true, opacity: 0.75, depthTest: false })));
    mesh.renderOrder = 1;
    return mesh;
  }
  function drawPlaceholder(canvas, hint) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // 浅灰底占位（与 3D 预览背景一致）
    ctx.fillStyle = '#dcdcdc'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8A97A5'; ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(hint || 'Empty', W / 2, H / 2);
  }
  function renderPreview(canvas, plate) {
    var TH = window.THREE;
    if (!TH) { drawPlaceholder(canvas, ''); return; }
    var g = plate.geometry || {};
    ensureOffscreen();
    if (!offRenderer) { drawPlaceholder(canvas, g.fileName); return; }
    var mesh = null;
    var hasGeo = (g.shape && g.shape !== '') || g.fileName;
    if (!hasGeo) { drawPlaceholder(canvas, '空盘'); return; }
    try {
      if (g.fileName) mesh = buildImportedMesh(plate);
      else mesh = buildParametricMesh(g);
    } catch (e) { mesh = null; }
    if (!mesh) { drawPlaceholder(canvas, g.fileName || ''); return; }
    try {
      disposeOffscreen();
      offMesh = mesh; offScene.add(offMesh);
      var W = canvas.width, H = canvas.height;
      offRenderer.setSize(W, H, false);

      // 包围盒 + 居中 + 按画面尺寸计算相机距离
      var bb = new TH.Box3().setFromObject(offMesh);
      var size = new TH.Vector3(), center = new TH.Vector3();
      bb.getSize(size); bb.getCenter(center);
      var maxDim = Math.max(size.x, size.y, size.z, 0.1);
      // 把网格中心平移到原点，相机以原点为 lookAt 点
      offMesh.position.sub(center);

      var fov = 45;
      var aspect = W / H;
      // 让 maxDim × 1.04 占画面最短边的 96% （模型几乎填满画面，参考图片比例）
      var tanHalfFov = Math.tan(fov * Math.PI / 180 / 2);
      var distByH = (maxDim * 1.04 / 2) / tanHalfFov;
      var distByW = (maxDim * aspect * 1.04 / 2) / tanHalfFov;
      var camDist = Math.max(distByH, distByW);

      // 固定视角：方向向量恒定（右上 45° 俯视 + 30° 偏转），只按模型大小调整距离，
      // 保证所有工作区卡片的预览角度完全一致（模型归一化统一：长轴沿 X、绕 Z 抬 30°）
      var viewDir = new TH.Vector3(0.85, 0.95, 0.55).normalize();
      offCamera.position.copy(viewDir.multiplyScalar(camDist));
      offCamera.lookAt(0, 0, 0);
      offCamera.fov = fov; offCamera.aspect = aspect;
      offCamera.updateProjectionMatrix();
      offRenderer.render(offScene, offCamera);
      var cardCtx = canvas.getContext('2d'); cardCtx.clearRect(0, 0, W, H);
      cardCtx.drawImage(offRenderer.domElement, 0, 0);
    } catch (e) { drawPlaceholder(canvas, g.fileName || ''); }
    finally {
      // 还原网格的 position，避免累积偏移
      if (offMesh) { offMesh.position.set(0, 0, 0); disposeOffscreen(); }
    }
  }

  function t(key, fallback) {
    var fn = (window.LG && LG.i18n && LG.i18n.t) ? LG.i18n.t : null;
    return fn ? fn(key) : (fallback || key);
  }

  function refreshProjectIntoView() {
    if (window.LG && LG.state) LG.state.project = LG.Store.active();
  }

  function render() {
    refreshProjectIntoView();
    var wsList = LG.Store.listWorkspaces();
    var activeWs = LG.Store.activeWorkspace();

    var html = '<section class="home-page">'
      + '<div class="home-hero">'
      + '<h1>' + t('home.title', '导光柱验证平台') + '</h1>'
      + '<p class="home-sub">' + t('home.sub', '管理你的导光板设计工作区，每个工作区可包含多个仿真盘') + '</p>'
      + '<div class="home-actions">'
      + '<button id="home-new-ws" class="btn btn-primary">+ ' + t('home.newWs', '新建工作区') + '</button>'
      + '<button id="home-new-plate" class="btn">' + t('home.newPlate', '新建仿真盘') + '</button>'
      + '<button id="home-import" class="btn">' + t('home.import', '导入 .lgv.json') + '</button>'
      + '<button id="home-export-all" class="btn">' + t('home.exportAll', '全部导出') + '</button>'
      + '</div>'
      + '</div>';

    if (!wsList.length) {
      html += '<div class="home-empty">'
        + '<div class="home-empty-icon">📁</div>'
        + '<p>' + t('home.empty', '还没有工作区，点击上方按钮创建第一个') + '</p>'
        + '</div>';
    } else {
      html += '<div class="home-grid">';
      for (var i = 0; i < wsList.length; i++) {
        var ws = wsList[i];
        var isActive = activeWs && activeWs.id === ws.id;
        var plates = ws.plates || [];
        var totalRecords = 0;
        var hasAnyGeo = false;
        for (var p = 0; p < plates.length; p++) {
          totalRecords += (plates[p].records && plates[p].records.length) || 0;
          var gg = plates[p].geometry || {};
          if (gg.fileName || (gg.shape && gg.shape !== '')) hasAnyGeo = true;
        }
        html += '<div class="home-card' + (isActive ? ' is-active' : '') + '" data-ws="' + ws.id + '">'
          // 3D 预览置顶（白底），保证各卡片上下对齐
          + '<canvas class="home-preview" width="280" height="140" data-ws="' + ws.id + '"></canvas>'
          + '<div class="home-card-head">'
          + '<span class="home-card-name">' + (ws.name || t('home.untitledWs', '未命名工作区')) + '</span>'
          + (isActive ? '<span class="home-card-badge">' + t('home.current', '当前') + '</span>' : '')
          + '</div>'
          // 操作按钮紧跟项目名，避免被下方 3D 预览遮挡
          + '<div class="home-card-actions">'
          + '<button class="home-act home-act-open" data-act="open">' + t('home.open', '打开') + '</button>'
          + '<button class="home-act home-act-rename" data-act="rename">' + t('home.rename', '重命名') + '</button>'
          + '<button class="home-act home-act-export" data-act="export" title="导出为 .lgv.json，可再次导入">导出</button>'
          + '<button class="home-act home-act-del" data-act="del">' + t('home.delete', '删除') + '</button>'
          + '</div>'
          + '<div class="home-card-meta">'
          + '<span>📦 ' + plates.length + ' ' + t('home.plates', '个盘') + '</span>'
          + '<span>📊 ' + totalRecords + ' ' + t('home.runs', '次仿真') + '</span>'
          + (ws.owner ? '<span>👤 ' + ws.owner + '</span>' : '')
          + '</div>'
          + '<div class="home-card-time">' + fmtTime(ws.updatedAt || ws.createdAt) + '</div>';

        // 工作区内盘列表
        if (plates.length) {
          html += '<div class="home-ws-plates">';
          var maxShow = 3;
          for (var p2 = 0; p2 < Math.min(maxShow, plates.length); p2++) {
            var pl = plates[p2];
            var g2 = pl.geometry || {};
            var info = g2.fileName ? g2.fileName : (g2.shape ? ('param:' + g2.shape) : t('home.emptyPlate', '空盘'));
            html += '<div class="home-ws-plate-row"><span>▸</span> '
              + '<span class="ws-plate-name">' + (pl.name || t('home.untitledPlate', '未命名盘')) + '</span>'
              + '<span class="ws-plate-info">' + info + '</span></div>';
          }
          if (plates.length > maxShow) {
            html += '<div class="home-ws-plate-more">+ ' + (plates.length - maxShow) + ' ' + t('home.morePlates', '个盘') + '</div>';
          }
          html += '</div>';
        } else {
          html += '<div class="home-ws-empty">' + t('home.wsEmpty', '工作区内还没有仿真盘') + '</div>';
        }

        html += '</div>';
      }
      html += '</div>';
    }
    html += '</section>';
    document.getElementById('view').innerHTML = html;
    bind(wsList);
  }

  function bind(wsList) {
    var $ = function (id) { return document.getElementById(id); };
    $('home-new-ws').addEventListener('click', function () {
      var name = prompt(t('home.newWsName', '输入工作区名称'), '');
      if (name === null) return;
      LG.Store.createWorkspace(name && name.trim() ? name.trim() : undefined);
      refreshProjectIntoView();
      render();
    });
    $('home-new-plate').addEventListener('click', function () {
      var ws = LG.Store.activeWorkspace();
      if (!ws) { alert(t('home.needWs', '请先新建或打开一个工作区')); return; }
      var p = LG.Store.create(undefined, ws.id);
      refreshProjectIntoView();
      location.hash = '#/model';
    });
    $('home-import').addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,.lgv.json,application/json';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var r = LG.Store.importJSON(reader.result);
            refreshProjectIntoView();
            alert(t('home.importOk2', '已导入 {w} 个工作区 / {p} 个盘').replace('{w}', r.wsCount).replace('{p}', r.plateCount));
            render();
          } catch (e) { alert(t('home.importFail', '导入失败：') + e.message); }
        };
        reader.readAsText(f);
      });
      input.click();
    });
    $('home-export-all').addEventListener('click', function () {
      if (!LG.Store.listWorkspaces().length) { alert(t('home.empty', '还没有工作区')); return; }
      LG.Store.exportAll();
    });

    // 卡片点击
    var cards = document.querySelectorAll('.home-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function (e) {
        var actBtn = e.target.closest('.home-act');
        var wsId = this.getAttribute('data-ws');
        if (actBtn) {
          e.stopPropagation();
          handleCardAct(wsId, actBtn.getAttribute('data-act'));
          return;
        }
        openWorkspace(wsId);
      });
    }

    // 预览：渲染每个工作区里最新的那个盘
    var previews = document.querySelectorAll('.home-preview');
    for (var pi = 0; pi < previews.length; pi++) {
      var cv = previews[pi];
      var wsId = cv.getAttribute('data-ws');
      var ws2 = LG.Store.listWorkspaces().find(function (w) { return w.id === wsId; });
      if (!ws2 || !ws2.plates || !ws2.plates.length) continue;
      // 找最后更新的 plate 来展示（比默认第一个更有代表性）
      var best = ws2.plates[0], bestTs = best.updatedAt || best.createdAt || 0;
      for (var p = 1; p < ws2.plates.length; p++) {
        var ts = ws2.plates[p].updatedAt || ws2.plates[p].createdAt || 0;
        if (ts > bestTs) { best = ws2.plates[p]; bestTs = ts; }
      }
      renderPreview(cv, best);
    }
  }

  function openWorkspace(wsId) {
    var ws = LG.Store.listWorkspaces().find(function (w) { return w.id === wsId; });
    if (!ws) return;
    LG.Store.setActiveWorkspace(wsId);
    // 进入 model 页前确保激活一个盘
    if (ws.plates.length) {
      var latest = ws.plates[0], latestTs = latest.updatedAt || latest.createdAt || 0;
      for (var p = 1; p < ws.plates.length; p++) {
        var ts = ws.plates[p].updatedAt || ws.plates[p].createdAt || 0;
        if (ts > latestTs) { latest = ws.plates[p]; latestTs = ts; }
      }
      LG.Store.setActive(latest.id);
    } else {
      // 空工作区 → 自动建一个盘让用户开始
      LG.Store.create(undefined, wsId);
    }
    refreshProjectIntoView();
    location.hash = '#/model';
  }

  function handleCardAct(wsId, act) {
    var ws = LG.Store.listWorkspaces().find(function (w) { return w.id === wsId; });
    if (!ws) return;
    if (act === 'open') {
      openWorkspace(wsId);
    } else if (act === 'rename') {
      var name = prompt(t('home.renameWsName', '重命名工作区'), ws.name || '');
      if (!name || !name.trim()) return;
      LG.Store.renameWorkspace(wsId, name.trim());
      render();
    } else if (act === 'export') {
      LG.Store.exportWorkspace(wsId);
    } else if (act === 'del') {
      if (!confirm(t('home.delWsConfirm', '确定删除工作区「{name}」及其全部 {n} 个盘？').replace('{name}', ws.name || '').replace('{n}', ws.plates.length))) return;
      LG.Store.removeWorkspace(wsId);
      refreshProjectIntoView();
      render();
    }
  }

  window.LG = window.LG || {};
  LG.Modules = LG.Modules || {};
  LG.Modules.home = { render: render };
})();
