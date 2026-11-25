/**
 * LG.Store — 两级持久层
 *  v2：工作区（Workspace） → 盘（Plate，即原来的"项目"）
 *      工作区 = 一个 .lgv.json 文件 / 一个开发者的独立工程
 *      盘 = 工作区内的一个仿真配置（geometry/material/led/source 等）
 *
 *  Home 页按工作区展示卡片，打开工作区后进入 model 页的多盘并排视图。
 *  对外 API 保持 `active()` / `list()` 语义不变：
 *    active()  → 当前激活盘（Plate）
 *    list()    → 当前工作区的盘列表
 */
(function () {
  'use strict';
  var KEY_WS = 'lgv.workspaces.v2', KACTIVE_WS = 'lgv.activeWs.v2', KACTIVE_PLATE = 'lgv.activePlate.v2';
  // 兼容老数据：v1 的 projects 数组（一次使用后立即迁移成 v2）
  var KEY_V1 = 'lgv.projects.v1', KACTIVE_V1 = 'lgv.active.v1';
  var workspaces = [], activeWsId = null, activePlateId = null;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ================= 盘的默认配置（从原 v1 defaults 迁过来） =================
  function plateDefaults() {
    return {
      geometry: {
        shape: '', d1: 3, d2: 3, length: 30, radialSeg: 48,
        teeth: { enabled: false, step: 1, width: 0.8, aStart: 85, aEnd: 10, offset: 2 },
        fileName: '',
        useParametric: false,
        transform: { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 },
        surface: {
          inputTex: 'polished', inputSigma: 0,
          inputCurve: 'flat', inputCurveR: 20,
          outputTex: 'polished', outputSigma: 0,
          outputCurve: 'flat', outputCurveR: 20,
          sideTex: 'polished', sideSigma: 0,
          sideProfile: 'straight', sideDeltaR: 0.3
        }
      },
      material: { preset: '1.49,0.0005', n: 1.49, alpha: 0.0005, abbe: 57.4, diffusion: 'none' },
      led: {
        enabled: true, type: 'rectangle',
        // 与默认型号 0603（eng.ledModel）的封装尺寸保持一致：1.6 × 0.8 × 0.8
        length: 1.6, width: 0.8, height: 0.8, gap: 0.5,
        concaveDepth: 0.4, convexRadius: 0.6,
        rotZ: 0
      },
      source: {
        type: 'surface', mode: 'lambert', flux: 683, wavelength: 555,
        angleSigma: 12, posSigma: 0.3, srcDist: 0,
        numRays: 20000, maxBounces: 30,
        spectrum: {
          enabled: false, preset: 'rgb',
          wavelengths: [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }]
        }
      },
      faces: { input: [], output: [] },
      beads: [{ input: [], output: [], on: true }],
      records: [],
      measurements: [],
      scheme: {
        type: 'straight', template: '',
        bendAngle: 90, bendR: 3, draftAngle: 1
      },
      eng: {
        material: 'pmma', ledModel: '0603', ledLevel: 'typ',
        assemblyGap: 0.1, offsetX: 0, offsetY: 0,
        housing: 'black', foam: true, reflector: false,
        targets: { brightness: true, uniformity: true, leak: true,
                   tolerance: true, bendLoss: false, crosstalk: false, molding: true },
        checkedAt: 0
      },
      locked: false,
      plateId: ''   // 所属工作区 id（由上层 workspace.plateOf 统一算）
    };
  }

  // ================= 老版本迁移 =================
  var PRESET_REMAP = {
    '1.586,0.40': '1.586,0.002',
    '1.49,0.10':  '1.49,0.0005',
    '1.59,0.30':  '1.59,0.0015',
    '1.575,0.35': '1.575,0.0018',
    '1.533,0.08': '1.533,0.0004',
    '1.517,0.01': '1.517,0.00005'
  };
  var ABBE_BY_PRESET = {
    '1.586,0.002': 30.0, '1.49,0.0005': 57.4, '1.59,0.0015': 30.9,
    '1.575,0.0018': 42.0, '1.533,0.0004': 56.0, '1.517,0.00005': 64.2
  };
  var PRESET_TO_LIB = {
    '1.49,0.0005': 'pmma', '1.586,0.002': 'pc',
    '1.59,0.0015': 'ms', '1.575,0.0018': 'ms',
    '1.533,0.0004': 'pc_diffuse', '1.517,0.00005': 'pmma'
  };

  function defaultAbbe(preset) { return ABBE_BY_PRESET[preset] != null ? ABBE_BY_PRESET[preset] : 57.4; }

  function migratePlateCommon(p) {
    if (!p) return false;
    var d = plateDefaults();
    var changed = false;
    // LED 型号库尺寸（与 model.js 的 LED_LIB 一致，只用长/宽/高）
    var LED_DIMS = {
      '0402': [1.0, 0.5, 0.6], '0603': [1.6, 0.8, 0.8], '2835': [3.5, 2.8, 0.8],
      '3528': [3.5, 2.8, 1.9], 'top': [3.0, 3.0, 1.2], 'side': [3.0, 1.0, 1.4]
    };
    var m = p.material;
    if (m && PRESET_REMAP[m.preset]) { m.preset = PRESET_REMAP[m.preset]; m.alpha = parseFloat(m.preset.split(',')[1]); changed = true; }
    else if (m && m.alpha > 0.01) { m.alpha = m.alpha / 200; changed = true; }
    if (m && m.abbe == null) { m.abbe = defaultAbbe(m.preset); changed = true; }
    if (m && m.diffusion == null) { m.diffusion = 'none'; changed = true; }
    if (p.source && !p.source.spectrum) {
      p.source.spectrum = { enabled: false, preset: 'rgb', wavelengths: [{ nm: 450, weight: 1 }, { nm: 550, weight: 1 }, { nm: 650, weight: 1 }] };
      changed = true;
    }
    if (!p.scheme) { p.scheme = JSON.parse(JSON.stringify(d.scheme));
      if (p.geometry && p.geometry.teeth && p.geometry.teeth.enabled) p.scheme.type = 'straight'; changed = true; }
    if (!p.eng) { p.eng = JSON.parse(JSON.stringify(d.eng)); changed = true; }
    if (p.eng && !p.eng.material && p.material) { p.eng.material = PRESET_TO_LIB[p.material.preset] || 'custom'; changed = true; }
    if (p.eng && !p.eng.targets) { p.eng.targets = JSON.parse(JSON.stringify(d.eng.targets)); changed = true; }
    if (p.eng && p.eng.assemblyGap == null && p.led && p.led.gap != null) { p.eng.assemblyGap = p.led.gap; changed = true; }
    if (p.geometry && !p.geometry.surface) { p.geometry.surface = JSON.parse(JSON.stringify(d.geometry.surface)); changed = true; }
    // LED 默认开启
    if (p.led && p.led.enabled === false) { p.led.enabled = true; changed = true; }
    // LED 型号 ↔ 发光面尺寸对齐：历史默认尺寸为 3×2×1.5，而默认型号 0603 实为 1.6×0.8×0.8，
    // 导致配置栏显示型号 0603、尺寸却是 3×2，盘上灯珠被画大。仅在“仍是旧默认尺寸”时按型号库纠正一次。
    if (p.led) {
      var libDims = LED_DIMS[p.eng && p.eng.ledModel];
      var isOldDefault = (+p.led.length === 3 && +p.led.width === 2 && +p.led.height === 1.5);
      if (libDims && isOldDefault &&
          (+p.led.length !== libDims[0] || +p.led.width !== libDims[1] || +p.led.height !== libDims[2])) {
        p.led.length = libDims[0]; p.led.width = libDims[1]; p.led.height = libDims[2];
        changed = true;
      }
    }
    // 默认光线数 20000
    if (p.source && p.source.numRays === 1000) { p.source.numRays = 20000; changed = true; }
    // 默认空盘：纯默认参数化圆柱清空
    var g = p.geometry;
    if (g && g.shape === 'cylinder' && g.fileName === '' && g.useParametric !== false &&
        (!g.transform || (g.transform.posX === 0 && g.transform.posY === 0 && g.transform.posZ === 0 &&
                          g.transform.rotX === 0 && g.transform.rotY === 0 && g.transform.rotZ === 0)) &&
        ((+g.d1 === 3 && +g.d2 === 3 && +g.length === 30) || (isNaN(+g.d1) && isNaN(+g.d2) && isNaN(+g.length)))) {
      g.shape = ''; g.useParametric = false; changed = true;
    }
    return changed;
  }

  /** 一次性把 v1 localStorage 迁移成 v2（所有老项目 → 一个默认工作区） */
  function migrateV1toV2() {
    try {
      var oldRaw = localStorage.getItem(KEY_V1);
      if (!oldRaw) return false;     // v1 没数据 → 跳过
      if (localStorage.getItem(KEY_WS)) return false;   // v2 已有 → 跳过（幂等）
      var oldProjs = JSON.parse(oldRaw) || [];
      var oldActiveId = localStorage.getItem(KACTIVE_V1) || null;
      // 把老项目打包成一个默认工作区
      var ws = {
        id: 'ws_default',
        name: '默认工作区',
        owner: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        plates: []
      };
      for (var i = 0; i < oldProjs.length; i++) {
        var op = oldProjs[i];
        if (!op || !op.geometry) continue;
        // 老项目 plateId 字段现在作废（统一指向 workspace），清掉让 plateIdOf 正确算
        delete op.plateId;
        migratePlateCommon(op);
        op.updatedAt = op.updatedAt || op.createdAt || Date.now();
        ws.plates.push(op);
      }
      ws.updatedAt = Date.now();
      workspaces = [ws];
      activeWsId = ws.id;
      if (oldActiveId && ws.plates.some(function (p) { return p.id === oldActiveId; })) {
        activePlateId = oldActiveId;
      } else if (ws.plates.length) {
        activePlateId = ws.plates[0].id;
      }
      localStorage.setItem(KEY_WS, JSON.stringify(workspaces));
      localStorage.setItem(KACTIVE_WS, activeWsId || '');
      localStorage.setItem(KACTIVE_PLATE, activePlateId || '');
      // 迁移完成后清掉 v1 key（保留一份备份以防万一）
      localStorage.removeItem(KEY_V1);
      localStorage.removeItem(KACTIVE_V1);
      return true;
    } catch (e) { console.warn('[Store] v1→v2 migration failed', e); return false; }
  }

  function load() {
    try {
      if (!migrateV1toV2()) {
        workspaces = JSON.parse(localStorage.getItem(KEY_WS) || '[]');
        activeWsId = localStorage.getItem(KACTIVE_WS) || null;
        activePlateId = localStorage.getItem(KACTIVE_PLATE) || null;
      }
    } catch (e) { workspaces = []; activeWsId = null; activePlateId = null; }
    // 老工作区里所有 plate 统一跑一次 migrate（幂等）
    var changed = false;
    for (var w = 0; w < workspaces.length; w++) {
      var ws = workspaces[w];
      for (var i = 0; i < (ws.plates || []); i++) {
        if (migratePlateCommon(ws.plates[i])) changed = true;
      }
    }
    if (changed) save();
  }

  function save() {
    try { localStorage.setItem(KEY_WS, JSON.stringify(workspaces)); } catch (e) { console.error('localStorage save failed', e); }
    localStorage.setItem(KACTIVE_WS, activeWsId || '');
    localStorage.setItem(KACTIVE_PLATE, activePlateId || '');
  }

  // ================= 工作区 API =================
  function listWorkspaces() { return workspaces; }
  function activeWorkspace() {
    for (var i = 0; i < workspaces.length; i++) if (workspaces[i].id === activeWsId) return workspaces[i];
    return workspaces.length ? workspaces[0] : null;
  }

  function createWorkspace(name) {
    var ws = {
      id: uid(),
      name: name || ('Workgroup-' + new Date().toISOString().slice(5, 16).replace('T', ' ')),
      owner: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      plates: []
    };
    workspaces.unshift(ws);
    activeWsId = ws.id;
    save();
    return ws;
  }

  function removeWorkspace(id) {
    workspaces = workspaces.filter(function (w) { return w.id !== id; });
    if (activeWsId === id) {
      activeWsId = workspaces.length ? workspaces[0].id : null;
      activePlateId = null;
    }
    save();
  }

  function renameWorkspace(id, name) {
    var w = workspaceById(id);
    if (w && name && name.trim()) { w.name = name.trim(); w.updatedAt = Date.now(); save(); }
  }

  function workspaceById(id) {
    for (var i = 0; i < workspaces.length; i++) if (workspaces[i].id === id) return workspaces[i];
    return null;
  }

  // ================= 盘 API（兼容层：语义不变） =================

  /** 新建盘（默认进当前工作区，否则自动建一个默认工作区） */
  function create(name, wsId) {
    var ws = workspaceById(wsId) || activeWorkspace();
    if (!ws) { ws = createWorkspace('默认工作区'); }
    var p = plateDefaults();
    p.id = uid();
    p.name = name || ('Plate-' + (ws.plates.length + 1));
    p.createdAt = Date.now(); p.updatedAt = Date.now();
    ws.plates.unshift(p);
    ws.updatedAt = Date.now();
    activeWsId = ws.id;
    activePlateId = p.id;
    save();
    return p;
  }

  /** 返回当前工作区的盘列表（保持与原 v1 Store.list() 相同语义） */
  function list() {
    var ws = activeWorkspace();
    return ws ? ws.plates.slice() : [];
  }

  /** 返回当前激活盘（保持与原 v1 Store.active() 相同语义） */
  function active() {
    var ws = activeWorkspace();
    if (!ws || !ws.plates.length) return null;
    // 优先用 activePlateId；否则取当前工作区第一个
    var cur = null;
    if (activePlateId) {
      for (var i = 0; i < ws.plates.length; i++) if (ws.plates[i].id === activePlateId) { cur = ws.plates[i]; break; }
    }
    if (!cur) cur = ws.plates[0];
    // 激活的盘必须属于激活的工作区
    if (cur) { activePlateId = cur.id; save(); }
    return cur;
  }

  /** 切换当前激活盘（同时确保工作区对应） */
  function setActive(id) {
    // 先在所有工作区里找到这个盘
    for (var w = 0; w < workspaces.length; w++) {
      var ws = workspaces[w];
      for (var i = 0; i < ws.plates.length; i++) {
        if (ws.plates[i].id === id) {
          activeWsId = ws.id;
          activePlateId = id;
          save();
          return;
        }
      }
    }
  }

  function get(id) {
    for (var w = 0; w < workspaces.length; w++) {
      var ws = workspaces[w];
      for (var i = 0; i < ws.plates.length; i++) if (ws.plates[i].id === id) return ws.plates[i];
    }
    return null;
  }

  function remove(id) {
    for (var w = 0; w < workspaces.length; w++) {
      var ws = workspaces[w];
      var before = ws.plates.length;
      ws.plates = ws.plates.filter(function (p) { return p.id !== id; });
      if (ws.plates.length !== before) {
        ws.updatedAt = Date.now();
        if (activePlateId === id) activePlateId = ws.plates.length ? ws.plates[0].id : null;
        save();
        return;
      }
    }
  }

  function rename(id, name) {
    var p = get(id);
    if (p && name && name.trim()) { p.name = name.trim(); p.updatedAt = Date.now(); save(); }
  }

  /** 盘所属盘位（老 plateId 字段作废，统一由工作区 id 承担） */
  function plateIdOf(proj) {
    var ws = activeWorkspace();
    return (ws && ws.id) || (proj && proj.plateId) || (proj && proj.id) || '';
  }

  function updateActive(patch) {
    var p = active(); if (!p) return null;
    for (var k in patch) p[k] = patch[k];
    p.updatedAt = Date.now();
    var ws = activeWorkspace(); if (ws) ws.updatedAt = Date.now();
    save();
    return p;
  }

  function update(id, patch) {
    var p = get(id); if (!p) return null;
    for (var k in patch) p[k] = patch[k];
    p.updatedAt = Date.now();
    var ws = activeWorkspace(); if (ws) ws.updatedAt = Date.now();
    save();
    return p;
  }

  function move(id, toIndex) {
    var ws = activeWorkspace(); if (!ws) return false;
    var from = -1;
    for (var i = 0; i < ws.plates.length; i++) if (ws.plates[i].id === id) { from = i; break; }
    if (from < 0) return false;
    var to = Math.max(0, Math.min(ws.plates.length - 1, toIndex));
    if (to === from) return false;
    var p = ws.plates.splice(from, 1)[0];
    ws.plates.splice(to, 0, p);
    ws.updatedAt = Date.now();
    save();
    return true;
  }

  function toggleLock(id) {
    var p = get(id); if (!p) return null;
    p.locked = !p.locked;
    p.updatedAt = Date.now();
    save();
    return p.locked;
  }

  // ================= 仿真记录 / 实测 =================
  function addRecord(rec) {
    var p = active(); if (!p) return null;
    rec.id = uid(); rec.time = Date.now();
    p.records.unshift(rec);
    p.updatedAt = Date.now();
    save();
    return rec;
  }
  function removeRecord(recId) {
    var p = active(); if (!p) return;
    p.records = p.records.filter(function (r) { return r.id !== recId; });
    save();
  }
  function getRecord(recId) {
    var p = active(); if (!p) return null;
    for (var i = 0; i < p.records.length; i++) if (p.records[i].id === recId) return p.records[i];
    return null;
  }
  function addMeasurement(m) {
    var p = active(); if (!p) return null;
    m.id = uid();
    p.measurements.unshift(m);
    p.updatedAt = Date.now();
    save();
    return m;
  }
  function removeMeasurement(id) {
    var p = active(); if (!p) return;
    p.measurements = p.measurements.filter(function (m) { return m.id !== id; });
    save();
  }

  // ================= 导入 / 导出 =================

  /** 导出：单工作区的全部盘 → 一个 .lgv.json */
  function exportWorkspace(wsId) {
    var ws = workspaceById(wsId) || activeWorkspace();
    if (!ws) return;
    var payload = {
      app: 'light-guide-validator', version: 2,
      workspace: { id: ws.id, name: ws.name, owner: ws.owner,
                   createdAt: ws.createdAt, updatedAt: ws.updatedAt,
                   plates: ws.plates }
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (ws.name || 'workspace') + '.lgv.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /** 导出全部工作区（打包成一个 JSON） */
  function exportAll() {
    var payload = { app: 'light-guide-validator', version: 2, workspaces: workspaces };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lgv-all-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /**
   * 导入 .lgv.json：v2（workspace）或 v1（projects）自动识别。
   * 返回 { wsCount, plateCount }。
   */
  function importJSON(text) {
    // 防呆：用户误把「报告生成 → 下载」出来的 HTML 报告丢进导入
    if (/^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(text)) {
      throw new Error('这是 HTML 报告文件，不是项目文件。\n\n项目导出请回到 Home 页，点工作区卡片上的「导出工作区」按钮，会得到一个 .lgv.json 文件，它可以再导入。\n\nHTML 报告是给客户看的验证报告，不包含可编辑的模型/参数。');
    }
    var data = JSON.parse(text);
    var wsCount = 0, plateCount = 0;
    if (data.workspace) {
      // 单工作区
      var ws = data.workspace;
      ws.id = uid();
      // 每个 plate 重新分配 id，避免和本地冲突
      for (var i = 0; i < (ws.plates || []); i++) {
        ws.plates[i].id = uid();
        migratePlateCommon(ws.plates[i]);
        plateCount++;
      }
      ws.createdAt = Date.now();
      ws.updatedAt = Date.now();
      ws.owner = ws.owner || '';
      ws.name = ws.name || ('Imported-' + wsCount);
      workspaces.unshift(ws);
      activeWsId = ws.id;
      if (ws.plates.length) activePlateId = ws.plates[0].id;
      wsCount = 1;
    } else if (data.workspaces) {
      // 多工作区
      for (var w = 0; w < data.workspaces.length; w++) {
        var ws2 = data.workspaces[w];
        ws2.id = uid();
        ws2.createdAt = Date.now();
        ws2.updatedAt = Date.now();
        ws2.owner = ws2.owner || '';
        ws2.name = ws2.name || ('Imported-' + wsCount);
        for (var j = 0; j < (ws2.plates || []); j++) {
          ws2.plates[j].id = uid();
          migratePlateCommon(ws2.plates[j]);
          plateCount++;
        }
        workspaces.unshift(ws2);
        wsCount++;
      }
      if (workspaces.length) activeWsId = workspaces[0].id;
      var firstWS = activeWorkspace();
      if (firstWS && firstWS.plates.length) activePlateId = firstWS.plates[0].id;
    } else {
      // v1 格式（projects 数组）或数组本身
      var projs = data.projects || (Array.isArray(data) ? data : null);
      if (!projs) throw new Error('bad format');
      var ws3 = {
        id: uid(),
        name: 'Imported-' + new Date().toISOString().slice(5, 10),
        owner: '',
        createdAt: Date.now(), updatedAt: Date.now(),
        plates: []
      };
      for (var k = 0; k < projs.length; k++) {
        var p = projs[k];
        if (!p || !p.geometry) continue;
        p.id = uid();
        migratePlateCommon(p);
        ws3.plates.push(p);
        plateCount++;
      }
      workspaces.unshift(ws3);
      activeWsId = ws3.id;
      if (ws3.plates.length) activePlateId = ws3.plates[0].id;
      wsCount = 1;
    }
    save();
    return { wsCount: wsCount, plateCount: plateCount };
  }

  function ensureProject() {
    load();
    if (!workspaces.length) {
      var ws = createWorkspace('默认工作区');
      create('', ws.id);
    }
    // 没有 activePlateId 或盘被删了 → 回退到工作区第一个
    var ws = activeWorkspace();
    if (ws && (!activePlateId || !ws.plates.some(function (p) { return p.id === activePlateId; }))) {
      activePlateId = ws.plates.length ? ws.plates[0].id : null;
    }
    save();
    return active();
  }

  // ================= 对外导出 =================
  window.LG = window.LG || {};
  LG.Store = {
    // 工作区级
    listWorkspaces: listWorkspaces, activeWorkspace: activeWorkspace,
    createWorkspace: createWorkspace, removeWorkspace: removeWorkspace, renameWorkspace: renameWorkspace,
    setActiveWorkspace: function (id) { activeWsId = id; save(); },
    // 盘级（保持兼容）
    create: create, list: list, active: active,
    setActive: setActive, remove: remove, rename: rename, get: get,
    plateIdOf: plateIdOf, updateActive: updateActive,
    move: move, toggleLock: toggleLock, update: update,
    addRecord: addRecord, removeRecord: removeRecord, getRecord: getRecord,
    addMeasurement: addMeasurement, removeMeasurement: removeMeasurement,
    // 导入导出（exportJSON 是 exportWorkspace 的别名，两个名字都支持调用）
    exportWorkspace: exportWorkspace, exportJSON: exportWorkspace, exportAll: exportAll, importJSON: importJSON,
    ensureProject: ensureProject,
    defaults: plateDefaults,
    MATERIAL_ABBE: ABBE_BY_PRESET, defaultAbbe: defaultAbbe
  };
})();
