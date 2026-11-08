/* 暖光村 · 波次清场 + BOSS 战斗 Demo
 * 玩家 = 人物素材/走路_高清/走路精灵表.webp（51 帧，朝左）+ 打击/frame_001..045
 * 小怪 = MonstersHD armed/skeleton（普通兵）、armed/imp（BOSS，放大 1.7×）
 *
 * ── 流程 ──
 * 第 1 区「村口」：3 波骷髅兵（2 / 3 / 4 只），清空后右侧出现箭头指引；
 *                  走到地图右边缘 → 自动进入第 2 区。
 * 第 2 区「风车丘」：BOSS 小恶魔，血厚、伤害高、攻击范围大；击破即通关。
 * 1–6 键仍可自由切区（调试/看素材用），R 键重来本区。
 *
 * ── 出拳规则（未改）──
 * 001-009 / 046-051 是走姿待机，不算拳；010-045 按每 4 张一套切成 9 拳。
 * 按一次 J 只播当前这一拳，播完立刻停住回待机；伤害只在伸臂/弧光帧判定，打空无特效。
 */
(function () {
  'use strict';

  /* ==================== 可调参数 ==================== */
  const CFG = {
    // —— 玩家 ——
    moveSpeedX: 145,        // 水平移动 px/s
    moveSpeedY: 72,         // 纵深移动 px/s
    attackReach: 86,        // 出拳命中距离（必须接近小怪的 54px 起手距离，否则永远打不到人）
    attackHeightTol: 20,    // 出拳命中的纵深容差（可走纵深共 62px，28 约等于要基本对齐）
    attackDamage: 14,       // 每拳伤害
    hitStopTime: 0.055,     // 命中顿帧 s
    shakeAmount: 5,         // 命中震屏幅度
    playerMaxHp: 100,
    playerInvuln: 0.75,     // 受击后无敌时间 s
    playerStun: 0.35,       // 受击僵直 s
    playerKnock: 14,        // 受击击退像素
    sparkHeight: 79,        // 命中特效高度：拳心距脚底 79px（在渲染画布上实测）
    sparkForward: 36,       // 拳心距角色中心 36px
    hitWindowFrames: 1,     // 命中判定窗口：判定帧 + 1 帧（共 2 帧）
    maxAttackers: 2,        // 同时最多几只小怪处于攻击状态，其余在周围游走等待
    // —— 普通小怪（骷髅兵）——
    mobHp: 42,              // 3 拳
    mobSpeed: 62,
    mobRange: 54,           // 进入这个距离就起手
    mobDamage: 7,
    mobAtkCd: 0.9,
    alignSpeedY: 56,        // 小怪在纵深方向对齐玩家的速度（低于玩家 72，仍可走位摆脱）
    // —— BOSS（小恶魔）——
    bossHp: 196,            // 14 拳
    bossSpeed: 44,
    bossRange: 76,
    bossDamage: 14,
    bossAtkCd: 1.7,
    bossScale: 1.9,
    // —— 波次 ——
    waveGap: 1.1,           // 两波之间停顿 s
    firstWaveDelay: 0.8,
    // —— 运行 ——
    loadConcurrency: 6,
    loadTimeoutMs: 8000,
    hudHz: 30,
    fallbackOrigin: 'http://127.0.0.1:8772'
  };

  const ZONE1_WAVES = [2, 3, 4];   // 第 1 区每波数量

  const $ = (s) => document.querySelector(s);
  const W = 640, H = 360;
  const R = 3;
  const ACTOR_H = 120;
  const GY_MIN = 272, GY_MAX = 334;
  const GX_MIN = 55, GX_MAX = W - 55;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const bg = $('#bg'), fg = $('#fg'), ui = $('#ui');
  [bg, fg, ui].forEach((c) => { c.width = W * R; c.height = H * R; });
  const bx = bg.getContext('2d'), fx = fg.getContext('2d'), ux = ui.getContext('2d');
  [bx, fx, ux].forEach((c) => { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; });

  const HD_W = 320, HD_H = 449, HD_FOOT_X = 171, HD_FOOT_Y = 439;
  const HD_SCALE = ACTOR_H / HD_H;
  const HD_FRAMES = 51;
  const CACHE_W = Math.round(HD_W * HD_SCALE * R);
  const CACHE_H = ACTOR_H * R;
  // 打击帧裁剪框：
  //  y 让「脚底」落在与走路帧同一行（走路帧脚底在归一化 431 行），否则出拳时人物会上浮约 10px；
  //  x 必须从 0 开始 —— 出拳帧的拳头最远伸到 x=29，原来从 70 起裁会把最后一拳的手指整只切掉。
  //  左移 70px 后画面内容整体右移 70*(320/620)≈36，锚点同步 +36 补偿，人物位置不变。
  const HIT_CROP = { x: 0, y: 214, w: 620, h: 870 };
  const PUNCH_FOOT_X = HD_FOOT_X + 36;      // 打击帧专用水平锚点（见上面的补偿）
  // 打击帧裁切窗口 620×870 比走路格 320×449 覆盖范围更大，直接映射过去角色会小 12~14%，
  // 实测走路角色高 423px、打击帧只有 365~373px，这里按 423/370≈1.145 放大补偿
  const PUNCH_SCALE = 1.145;
  const PUNCH_FPS = 12;
  const GROUP_COUNT = 9;
  const PUNCH_START = 9;
  const PUNCH_LEN = 4;
  const PUNCH_HIT = [0, 0, 1, 0, 0, 1, 0, 0, 0];
  function buildPunchFrames(n) {
    const s = PUNCH_START + n * PUNCH_LEN;
    return Array.from({ length: PUNCH_LEN }, (_, i) => s + i);
  }

  const ZONES = [
    { id: '01', name: '村口',     src: 'map素材/map_z01.png' },
    { id: '02', name: '风车丘',   src: 'map素材/map_z02.png' },
    { id: '03', name: '集市',     src: 'map素材/map_z03.png' },
    { id: '04', name: '溪谷',     src: 'map素材/map_z04.png' },
    { id: '05', name: '广场',     src: 'map素材/map_z05.png' },
    { id: '06', name: '黄昏空地', src: 'map素材/map_z06.png' }
  ];
  const BGM_SRC = 'assets/raw/gothicvania-town-files/GothicVania-town-files/Music/rpg_village02_loop.mp3';
  const MON_BASE = '人物素材/小怪动画包_MonstersHD/monsters/armed/';
  const WALK_SRC = '人物素材/走路_高清/走路精灵表.webp';
  const HIT_DIR = '人物素材/打击/';

  // 玩家只有 idle / walk 两套循环；punch 由按键逐帧驱动，不走这张表
  const P_ACTIONS = {
    idle: { frames: 1, fps: 4 },
    walk: { frames: 51, fps: 12 }
  };

  // 小怪种类：参数全部来自素材自带的 json（cell / frames / fps / ground_y）
  const KINDS = {
    skeleton: {
      name: '骷髅兵', base: MON_BASE + 'skeleton/', scale: 1.4,
      hp: CFG.mobHp, speed: CFG.mobSpeed, range: CFG.mobRange,
      dmg: CFG.mobDamage, atkCd: CFG.mobAtkCd, atkHitFrame: 3, hitTolY: 12, bodyH: 88,
      a: {
        idle:   { file: 'stance', left: 'stance_left', cw: 200, ch: 200, n: 8,  fps: 8,  gy: 185, loop: true,  off: 2 },
        run:    { file: 'run',    left: 'run_left',    cw: 184, ch: 162, n: 6,  fps: 12, gy: 157, loop: true,  off: 12 },
        attack: { file: 'attack', left: 'attack_left', cw: 200, ch: 200, n: 7,  fps: 12, gy: 185, loop: false, off: 5 },
        hurt:   { file: 'hurt',   left: 'hurt_left',   cw: 200, ch: 200, n: 6,  fps: 12, gy: 185, loop: false, off: 2 },
        death:  { file: 'death',  left: 'death_left',  cw: 260, ch: 200, n: 19, fps: 10, gy: 185, loop: false, off: 53 }
      }
    },
    boss: {
      name: '小恶魔', base: MON_BASE + 'imp/', scale: CFG.bossScale,
      hp: CFG.bossHp, speed: CFG.bossSpeed, range: CFG.bossRange,
      dmg: CFG.bossDamage, atkCd: CFG.bossAtkCd, atkHitFrame: 3, hitTolY: 18, bodyH: 129,
      a: {
        idle:   { file: 'stance', left: 'stance_left', cw: 300, ch: 250, n: 8,  fps: 8,  gy: 235, loop: true,  off: -25 },
        run:    { file: 'run',    left: 'run_left',    cw: 184, ch: 200, n: 6,  fps: 12, gy: 195, loop: true,  off: 14 },
        attack: { file: 'attack', left: 'attack_left', cw: 300, ch: 250, n: 7,  fps: 12, gy: 235, loop: false, off: 15 },
        hurt:   { file: 'hurt',   left: 'hurt_left',   cw: 300, ch: 250, n: 5,  fps: 12, gy: 235, loop: false, off: -30 },
        death:  { file: 'death',  left: 'death_left',  cw: 436, ch: 250, n: 22, fps: 10, gy: 235, loop: false, off: 54 }
      }
    }
  };

  // 每种怪的「像素→逻辑」比例只算一次，以站立（idle/stance）的格子高度为基准。
  // 素材里各动作的格子留白不同（骷髅站立格 200 高、奔跑格 162 高），
  // 若按当前动作的格子高度归一化，奔跑时角色会被放大近 30%，一停/一受击又缩回去。
  for (const K of Object.values(KINDS)) {
    K.pxScale = (ACTOR_H * K.scale) / K.a.idle.ch;
  }

  const WALK = new Array(HD_FRAMES);
  const ATTACK = new Array(HD_FRAMES);
  const MONSHEET = Object.create(null);
  const IMG = { zones: [], portrait: null };
  const MISSING = [];
  const JOBS = [];
  let doneCount = 0;
  let bgZone = -1;

  // 调试/验证用查询参数
  const QS = new URLSearchParams(location.search);
  const STEP = QS.get('step');
  const PRESS = parseInt(QS.get('press') || '0', 10) || 0;
  const GROUP = parseInt(QS.get('group') || '-1', 10);
  if (QS.get('origin')) CFG.fallbackOrigin = QS.get('origin');
  // 开始界面选的头像（start/girl1..4.jpg），0 表示用默认立绘
  const AVATAR_ID = Math.max(0, Math.min(4, parseInt(QS.get('avatar') || '0', 10) || 0));

  const G = {
    zone: 0, bgm: false,
    player: {
      x: 175, feetY: 312, hp: CFG.playerMaxHp, maxhp: CFG.playerMaxHp,
      side: '右', state: 'idle', frame: 0, t: 0, hitDone: false,
      flash: 0, knock: 0, invuln: 0, stun: 0
    },
    enemies: [],
    keys: {}, sparks: [], hitStop: 0, shake: 0, fade: 1,
    groupIdx: 0, playing: false, queued: false, punchFrames: [], playStep: 0, hitStep: 0,
    wave: 0, phase: 'wait', timer: CFG.firstWaveDelay, banner: null, kills: 0, bossDown: false
  };

  const audio = new Audio(BGM_SRC);
  audio.loop = true; audio.volume = 0.32;

  /* ==================== 资源加载（并发上限队列 + 超时兜底） ==================== */
  function makeFrame(im, sx, sy, sw, sh, tw, th) {
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(im, sx, sy, sw, sh, 0, 0, tw, th);
    return c;
  }

  function candidatesOf(src) {
    const rel = src.replace(/^\.\.\//, '');
    const list = [src, rel];
    if (CFG.fallbackOrigin) list.push(CFG.fallbackOrigin.replace(/\/$/, '') + '/' + rel);
    return list;
  }

  const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function loadOne(src, onload, retain) {
    const cands = candidatesOf(src);
    return new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= cands.length) { doneCount++; MISSING.push(src); resolve(); return; }
        const im = new Image();
        let settled = false, timer = 0;
        const finish = (ok) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          im.onload = im.onerror = null;
          if (!ok) { tryNext(); return; }
          doneCount++;
          try { onload(im); } catch (e) { MISSING.push(src + ' (' + e.message + ')'); }
          if (!retain) { try { im.src = BLANK_PX; } catch (e) { /* 忽略 */ } }
          resolve();
        };
        timer = setTimeout(() => finish(false), CFG.loadTimeoutMs);
        im.onload = () => finish(true);
        im.onerror = () => finish(false);
        im.src = cands[i++];
      };
      tryNext();
    });
  }

  const queue = [];
  let active = 0, pumping = false;
  function pump() {
    while (active < CFG.loadConcurrency && queue.length) {
      const task = queue.shift();
      active++;
      task().finally(() => { active--; pump(); });
    }
    pumping = false;
  }
  function job(src, onload, retain) {
    const p = new Promise((resolve) => {
      queue.push(() => loadOne(src, onload, retain).then(resolve));
    });
    JOBS.push(p);
    if (!pumping) { pumping = true; queueMicrotask(pump); }
    return p;
  }

  ZONES.forEach((z, i) => job(z.src, (im) => { IMG.zones[i] = im; bgZone = -1; }, true));
  if (AVATAR_ID) {
    job('start/girl' + AVATAR_ID + '.jpg', (im) => { IMG.portrait = im; IMG.portraitIsAvatar = true; }, true);
  } else {
    job('人物素材/立绘/正面_待机.png', (im) => { IMG.portrait = im; }, true);
  }

  job(WALK_SRC, (im) => {
    for (let i = 0; i < HD_FRAMES; i++) {
      WALK[i] = makeFrame(im, i * HD_W, 0, HD_W, HD_H, CACHE_W, CACHE_H);
    }
  });

  const PUNCH_USED = new Set();
  for (let g = 0; g < GROUP_COUNT; g++) buildPunchFrames(g).forEach((f) => PUNCH_USED.add(f));
  PUNCH_USED.forEach((idx) => {
    job(HIT_DIR + 'frame_' + String(idx + 1).padStart(3, '0') + '.png', (im) => {
      ATTACK[idx] = makeFrame(im, HIT_CROP.x, HIT_CROP.y, HIT_CROP.w, HIT_CROP.h, CACHE_W, CACHE_H);
    });
  });

  // 小怪：每条动作表只留一张源图，绘制时用源矩形取帧
  for (const [kind, K] of Object.entries(KINDS)) {
    for (const [act, a] of Object.entries(K.a)) {
      for (const dir of ['right', 'left']) {
        const file = dir === 'right' ? a.file : a.left;
        job(K.base + file + '.png', (im) => { MONSHEET[kind + '_' + act + '_' + dir] = im; }, true);
      }
    }
  }

  /* ==================== 玩家状态机 ==================== */
  function setPlayerState(s) {
    const p = G.player;
    if (p.state === s) return;
    p.state = s; p.frame = 0; p.t = 0;
  }

  function addSpark(x, y, color) {
    G.sparks.push({ x: x, y: y, t: 0, dur: 0.36, color: color, seed: Math.random() * 6.28 });
  }

  function attackOnce() {
    const p = G.player;
    if (p.state === 'hurt') return;
    // 出拳中再按 J 不再丢弃，而是「记一次」，本拳播完立刻接下一拳
    if (G.playing) { G.queued = true; return; }
    G.punchFrames = buildPunchFrames(G.groupIdx);
    G.hitStep = PUNCH_HIT[G.groupIdx];
    G.playStep = 0;
    G.playing = true;
    p.state = 'punch'; p.frame = G.punchFrames[0]; p.t = 0; p.hitDone = false;
    maybeHit();
  }

  /* 命中判定窗口：把原来「单帧」放宽到 2 帧，
   * 敌人恰好在判定帧挪动一点也不会整拳白费；真的打到才结束判定 */
  function maybeHit() {
    const p = G.player;
    if (p.hitDone) return;
    if (G.playStep < G.hitStep || G.playStep > G.hitStep + CFG.hitWindowFrames) return;
    if (playerStrike()) p.hitDone = true;
  }

  /* 出拳判定：只打「朝向最近的那一只」；打空不出任何特效。返回是否命中 */
  function playerStrike() {
    const p = G.player;
    const reach = p.side === '右' ? 1 : -1;
    let best = null, bestD = Infinity;
    for (const e of G.enemies) {
      if (e.state === 'dead' || e.state === 'death') continue;
      const d = (e.x - p.x) * reach;
      if (d > -14 && d < CFG.attackReach && Math.abs(e.feetY - p.feetY) < CFG.attackHeightTol && d < bestD) {
        bestD = d; best = e;
      }
    }
    if (!best) return false;

    best.hp = Math.max(0, best.hp - CFG.attackDamage);
    best.flash = 0.2;
    best.x += reach * 6;                       // 轻微击退
    // 命中特效落在「拳头正前方」：x 取拳头位置与敌人近身侧中更靠玩家的那个，
    // y 取拳头高度（实测拳心约在脚底上方 40px），不再按怪物身高百分比算（那样会飘到头顶）
    const fistX = p.x + reach * CFG.sparkForward;
    const contactX = best.x - reach * 12;
    const spx = reach > 0 ? Math.min(fistX, contactX) : Math.max(fistX, contactX);
    addSpark(spx, p.feetY - CFG.sparkHeight, '#ffd873');
    G.hitStop = CFG.hitStopTime; G.shake = CFG.shakeAmount;
    if (best.hp <= 0) {
      best.state = 'death'; best.frame = 0; best.t = 0;
      G.kills++;
      if (best.kind === 'boss') G.bossDown = true;
    } else if (best.stunCd <= 0) {
      // 抗打断窗口内只掉血不踉跄：否则狂按 J 能把小怪永久打停，永远不会挨打
      best.stunCd = 0.8;
      best.atkCd = Math.max(best.atkCd, 0.25);
      best.state = 'hurt'; best.frame = 0; best.t = 0;
    }
    return true;
  }

  function hurtPlayer(dmg, fromX) {
    const p = G.player;
    if (p.invuln > 0 || p.hp <= 0) return;
    p.hp = Math.max(0, p.hp - dmg);
    p.flash = 0.35; p.invuln = CFG.playerInvuln; p.stun = CFG.playerStun;
    p.knock = (fromX > p.x ? -1 : 1) * CFG.playerKnock;
    p.hitDone = true;
    G.playing = false; G.queued = false;
    G.punchFrames = []; G.playStep = 0;
    setPlayerState('hurt');
    G.shake = 4; G.hitStop = 0.03;
    if (p.hp <= 0) {
      showBanner('倒下了', '本波重来');
      respawnPlayer();
      if (G.zone === 0 || G.zone === 1) { G.phase = 'wait'; G.timer = 1.6; }
    }
  }

  function respawnPlayer() {
    const p = G.player;
    p.hp = CFG.playerMaxHp; p.x = 175; p.feetY = 312; p.side = '右';
    p.knock = 0; p.flash = 0; p.invuln = 1.2; p.stun = 0; p.hitDone = false;
    setPlayerState('idle');
    G.playing = false; G.queued = false; G.punchFrames = []; G.playStep = 0; G.hitStep = 0;
    G.sparks.length = 0;
    clearEnemies();
  }

  function advancePlayer(dt) {
    const p = G.player;
    if (p.state === 'punch') {
      if (!G.playing) return;
      p.t += dt * 1000;
      const dur = 1000 / PUNCH_FPS;
      while (p.t >= dur) {
        p.t -= dur;
        G.playStep++;
        if (G.playStep >= G.punchFrames.length) {
          G.playing = false;
          G.groupIdx = (G.groupIdx + 1) % GROUP_COUNT;
          setPlayerState('idle');
          // 出拳途中被按过 J → 立刻接下一拳（一拳一次按键，不会自动连打）
          if (G.queued) { G.queued = false; attackOnce(); }
          return;
        }
        p.frame = G.punchFrames[G.playStep];
        maybeHit();
      }
      return;
    }
    const a = P_ACTIONS[p.state];
    if (!a) return;
    p.t += dt * 1000;
    const dur = 1000 / a.fps;
    while (p.t >= dur) {
      p.t -= dur; p.frame++;
      if (p.frame >= a.frames) p.frame = 0;
    }
  }

  /* ==================== 小怪：生成 / AI / 动画 ==================== */
  let eid = 0;
  function makeEnemy(kind, x, feetY) {
    const K = KINDS[kind];
    return {
      id: ++eid, kind, x: x, feetY: feetY,
      hp: K.hp, maxhp: K.hp,
      state: 'idle', frame: 0, t: 0, facing: -1,
      flash: 0, atkCd: 0.35, hitDone: false, deadTimer: 0, alpha: 1, stunCd: 0
    };
  }

  function aliveCount() {
    let n = 0;
    for (const e of G.enemies) if (e.state !== 'dead') n++;
    return n;
  }
  function clearEnemies() { G.enemies.length = 0; }

  function setEnemyState(e, s) {
    if (e.state === s) return;
    e.state = s; e.frame = 0; e.t = 0;
    if (s === 'attack') e.hitDone = false;
  }

  // 非循环动画：播完返回 true
  function stepAnim(e, a, dt) {
    e.t += dt * 1000;
    const dur = 1000 / a.fps;
    while (e.t >= dur) {
      e.t -= dur;
      if (e.frame + 1 >= a.n) { e.frame = a.n - 1; return true; }
      e.frame++;
    }
    return false;
  }
  // 循环动画
  function loopAnim(e, a, dt) {
    e.t += dt * 1000;
    const dur = 1000 / a.fps;
    let guard = 0;
    while (e.t >= dur && guard++ < 60) { e.t -= dur; e.frame = (e.frame + 1) % a.n; }
  }

  function spawnWave(i) {
    const count = ZONE1_WAVES[i];
    for (let k = 0; k < count; k++) {
      const fromLeft = k % 2 === 0;
      const e = makeEnemy('skeleton', fromLeft ? -46 - k * 22 : W + 46 + k * 22, 312 + ((k % 3) - 1) * 13);
      e.facing = fromLeft ? 1 : -1;
      G.enemies.push(e);
    }
    showBanner('第 ' + (i + 1) + ' / ' + ZONE1_WAVES.length + ' 波', count + ' 只骷髅兵');
    updateStatus();
  }

  function spawnBoss() {
    const e = makeEnemy('boss', W + 80, 312);
    e.facing = -1;
    G.enemies.push(e);
    showBanner('BOSS · 小恶魔', '打倒它');
    updateStatus();
  }

  // 单只小怪的 AI：追 → 进入攻击距离起手 → 打完硬直
  function updateEnemyAI(e, dt) {
    const K = KINDS[e.kind], p = G.player;
    const a = K.a[e.state] || K.a.idle;

    if (e.state === 'death') {
      if (stepAnim(e, a, dt)) { e.state = 'dead'; e.deadTimer = 0; e.frame = a.n - 1; }
      return;
    }
    if (e.state === 'dead') {
      e.deadTimer += dt;
      e.alpha = e.deadTimer < 0.45 ? 1 : clamp(1 - (e.deadTimer - 0.45) / 0.4, 0, 1);
      return;
    }
    if (e.state === 'hurt') {
      if (stepAnim(e, a, dt)) setEnemyState(e, 'idle');
      return;
    }
    if (e.state === 'attack') {
      const before = e.frame;
      const done = stepAnim(e, a, dt);
      if (!e.hitDone && e.frame >= K.atkHitFrame && before < K.atkHitFrame) {
        e.hitDone = true;
        if (Math.abs(p.x - e.x) < K.range + 8 && Math.abs(p.feetY - e.feetY) < K.hitTolY + 4) {
          hurtPlayer(K.dmg, e.x);
        }
      }
      if (done) { setEnemyState(e, 'idle'); e.atkCd = K.atkCd; }
      return;
    }

    // idle / run：横向、纵深都要对上才起手，否则先把位置追正
    const dx = p.x - e.x;
    const dist = Math.abs(dx);
    const dy = p.feetY - e.feetY;
    const dir = dx >= 0 ? 1 : -1;
    e.facing = dir;

    const inX = dist <= K.range;
    const inY = Math.abs(dy) <= K.hitTolY;

    if (inX && inY) {
      // 就位：等冷却 + 抢「进攻令牌」，没抢到就在原地压着，不挥空刀
      setEnemyState(e, 'idle');
      loopAnim(e, K.a.idle, dt);
      if (e.atkCd <= 0 && attackerCount() < CFG.maxAttackers) setEnemyState(e, 'attack');
      return;
    }

    setEnemyState(e, 'run');
    loopAnim(e, K.a.run, dt);

    if (!inX) {
      const blocker = findBlocker(e, dir);
      if (!blocker) {
        e.x += dir * K.speed * dt;
        // 只有不被挡时才对齐纵深；否则「绕行」和「对齐」会互相抵消
        if (Math.abs(dy) > 1) e.feetY += clamp(dy, -1, 1) * CFG.alignSpeedY * dt;
      } else if (Math.abs(dy) < 28) {
        // 被同伴挡住：错开纵深让位，但不跑出玩家的纵深带
        const away = (blocker.feetY >= e.feetY) ? -1 : 1;
        e.feetY += away * K.speed * 0.6 * dt;
      }
    } else if (Math.abs(dy) > 1) {
      e.feetY += clamp(dy, -1, 1) * CFG.alignSpeedY * dt;
    }
    e.x = clamp(e.x, 20, W - 20);
    e.feetY = clamp(e.feetY, GY_MIN - 8, GY_MAX + 8);
  }

  // 同时处于攻击状态的怪有几只（用于进攻令牌）
  function attackerCount() {
    let n = 0;
    for (const e of G.enemies) if (e.state === 'attack') n++;
    return n;
  }
  // 正前方挡路的同伴
  function findBlocker(e, dir) {
    for (const o of G.enemies) {
      if (o === e || o.state === 'dead') continue;
      if (Math.sign(o.x - e.x) === dir && Math.abs(o.x - e.x) < 46) return o;
    }
    return null;
  }

  function updateEnemies(dt) {
    for (const e of G.enemies) {
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 2);
      if (e.stunCd > 0) e.stunCd = Math.max(0, e.stunCd - dt);
      // 冷却统一在这里推进：以前只在「站定」时递减，追人途中冷却不走，节奏很怪
      if (e.state !== 'attack') e.atkCd = Math.max(0, e.atkCd - dt);
      updateEnemyAI(e, dt);
    }
    // 尸体淡出后清掉
    for (let i = G.enemies.length - 1; i >= 0; i--) {
      const e = G.enemies[i];
      if (e.state === 'dead' && e.alpha <= 0) G.enemies.splice(i, 1);
    }
  }

  /* ==================== 区域 / 波次流程 ==================== */
  function showBanner(title, sub) {
    G.banner = { title: title, sub: sub, t: 0, dur: 2.2 };
  }

  function updateStatus() {
    const el = $('#status');
    if (!el) return;
    const z = ZONES[G.zone];
    let s = '运行中 · 第 ' + z.id + ' 区「' + z.name + '」';
    if (G.zone === 0) {
      s += G.phase === 'clear' ? ' · 本区清空，向右走出地图' : ' · 第 ' + Math.min(G.wave + 1, ZONE1_WAVES.length) + '/' + ZONE1_WAVES.length + ' 波';
    } else if (G.zone === 1) {
      s += G.phase === 'clear' ? ' · BOSS 已击破' : ' · BOSS 战';
    }
    el.textContent = s;
  }

  function resetZone() {
    respawnPlayer();
    G.kills = 0;
    G.wave = 0;
    G.banner = null;
    G.bossDown = false;
    if (G.zone === 0) { G.phase = 'wait'; G.timer = CFG.firstWaveDelay; }
    else if (G.zone === 1) { G.phase = 'wait'; G.timer = 0.6; }
    else { G.phase = 'none'; }
    updateStatus();
  }

  function updateFlow(dt) {
    if (G.zone === 0) {
      if (G.phase === 'wait') {
        G.timer -= dt;
        if (G.timer <= 0) { G.phase = 'fight'; spawnWave(G.wave); }
      } else if (G.phase === 'fight') {
        if (aliveCount() === 0) {
          if (G.wave + 1 < ZONE1_WAVES.length) {
            G.wave++; G.phase = 'wait'; G.timer = CFG.waveGap;
          } else {
            G.phase = 'clear';
            showBanner('本区清空', '向右走出地图 →');
            updateStatus();
          }
        }
      }
    } else if (G.zone === 1) {
      if (G.phase === 'wait') {
        G.timer -= dt;
        if (G.timer <= 0) { G.phase = 'fight'; spawnBoss(); }
      } else if (G.phase === 'fight') {
        if (G.bossDown && aliveCount() === 0) {
          G.phase = 'clear';
          showBanner('BOSS 已击破', '按 R 再来一次');
          updateStatus();
        }
      }
    }
    if (G.banner) {
      G.banner.t += dt;
      if (G.banner.t > G.banner.dur) G.banner = null;
    }
  }

  /* ==================== 玩家移动 ==================== */
  function updateMove(dt) {
    const p = G.player, k = G.keys;
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (p.state === 'hurt') {
      p.stun -= dt;
      if (p.stun <= 0) setPlayerState('idle');
      return;
    }
    if (p.state === 'punch') return;
    const dx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    const dy = (k.down ? 1 : 0) - (k.up ? 1 : 0);
    if (dx || dy) {
      const n = Math.hypot(dx, dy) || 1;
      p.x = clamp(p.x + dx / n * CFG.moveSpeedX * dt, GX_MIN, GX_MAX);
      p.feetY = clamp(p.feetY + dy / n * CFG.moveSpeedY * dt, GY_MIN, GY_MAX);
      if (dx) p.side = dx > 0 ? '右' : '左';
      setPlayerState('walk');
    } else setPlayerState('idle');

    // 第 1 区清空后，走到最右缘即换图
    if (G.zone === 0 && G.phase === 'clear' && p.x >= GX_MAX - 0.5) {
      setZone(1);
    }
  }

  /* ==================== 绘制 ==================== */
  const DEPTH_K = 0.12 / (GY_MAX - GY_MIN);
  function depthK(feetY) { return 0.88 + DEPTH_K * (feetY - GY_MIN); }

  function shadow(x, feetY, w) {
    fx.save(); fx.globalAlpha = 0.26; fx.fillStyle = '#160f08';
    fx.beginPath(); fx.ellipse(x, feetY - 1, w, 5, 0, 0, Math.PI * 2); fx.fill();
    fx.restore();
  }

  function missingBox(dx, dy, dw, dh) {
    fx.save();
    fx.fillStyle = 'rgba(28,34,46,.6)'; fx.fillRect(dx, dy, dw, dh);
    fx.strokeStyle = '#e2584d'; fx.lineWidth = 1; fx.setLineDash([4, 3]);
    fx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    fx.setLineDash([]);
    fx.fillStyle = '#ffb0a5'; fx.font = 'bold 11px monospace'; fx.textAlign = 'center';
    fx.fillText('素材?', dx + dw / 2, dy + dh / 2);
    fx.restore();
  }

  function paint(im, dx, dy, dw, dh, flip) {
    if (!flip) { fx.drawImage(im, dx, dy, dw, dh); return; }
    fx.save(); fx.translate(dx + dw, dy); fx.scale(-1, 1);
    fx.drawImage(im, 0, 0, dw, dh); fx.restore();
  }

  function paintCell(sheet, sx, sy, sw, sh, dx, dy, dw, dh, flip) {
    if (!flip) { fx.drawImage(sheet, sx, sy, sw, sh, dx, dy, dw, dh); return; }
    fx.save(); fx.translate(dx + dw, dy); fx.scale(-1, 1);
    fx.drawImage(sheet, sx, sy, sw, sh, 0, 0, dw, dh); fx.restore();
  }

  const scratch = document.createElement('canvas');
  const stx = scratch.getContext('2d');
  function drawTinted(im, sx, sy, sw, sh, dx, dy, dw, dh, flip, color) {
    const w = Math.max(1, Math.round(dw * R)), h = Math.max(1, Math.round(dh * R));
    if (scratch.width < w || scratch.height < h) {
      scratch.width = Math.max(w, scratch.width); scratch.height = Math.max(h, scratch.height);
    }
    stx.setTransform(1, 0, 0, 1, 0, 0);
    stx.clearRect(0, 0, w, h);
    stx.imageSmoothingEnabled = true; stx.imageSmoothingQuality = 'high';
    stx.drawImage(im, sx, sy, sw, sh, 0, 0, w, h);
    stx.globalCompositeOperation = 'source-atop';
    stx.globalAlpha = 0.45; stx.fillStyle = color; stx.fillRect(0, 0, w, h);
    stx.globalAlpha = 1; stx.globalCompositeOperation = 'source-over';
    if (!flip) { fx.drawImage(scratch, 0, 0, w, h, dx, dy, dw, dh); return; }
    fx.save(); fx.translate(dx + dw, dy); fx.scale(-1, 1);
    fx.drawImage(scratch, 0, 0, w, h, 0, 0, dw, dh); fx.restore();
  }

  function drawPlayer() {
    const p = G.player, k = depthK(p.feetY);
    const flip = p.side === '右';
    const punching = p.state === 'punch';
    const s = HD_SCALE * k * (punching ? PUNCH_SCALE : 1);
    const arr = punching ? ATTACK : WALK;
    const f = punching ? p.frame :
      (p.state === 'idle' || p.state === 'hurt') ? 0 : (p.frame % HD_FRAMES);
    const im = arr[f];
    const dw = HD_W * s, dh = HD_H * s;
    const anchorX = punching ? PUNCH_FOOT_X : HD_FOOT_X;
    const footX = flip ? (HD_W - anchorX) : anchorX;
    const dx = p.x - footX * s + p.knock;
    const dy = p.feetY - HD_FOOT_Y * s;
    shadow(p.x, p.feetY, 30 * k);
    if (!im) { missingBox(dx, dy, dw, dh); return; }
    // 受击闪红；无敌帧轻微半透明
    if (p.invuln > 0 && p.flash <= 0) fx.globalAlpha = 0.72;
    if (p.flash > 0) drawTinted(im, 0, 0, im.width, im.height, dx, dy, dw, dh, flip, '#ff6b5b');
    else paint(im, dx, dy, dw, dh, flip);
    fx.globalAlpha = 1;
  }

  function drawEnemy(e) {
    const K = KINDS[e.kind];
    const act = (e.state === 'dead') ? 'death' : e.state;
    const a = K.a[act] || K.a.idle;
    const dir = e.facing < 0 ? 'left' : 'right';
    const k = depthK(e.feetY), s = K.pxScale * k;   // 固定比例，不随动作格子大小变化
    const frame = clamp(e.frame | 0, 0, a.n - 1);
    const sheet = MONSHEET[e.kind + '_' + act + '_' + dir];
    const dw = a.cw * s, dh = a.ch * s;
    const dx = e.x - dw / 2 - (a.off || 0) * s;   // 抵消角色在格子里的偏心
    const dy = e.feetY - a.gy * s;
    shadow(e.x, e.feetY, 28 * k * K.scale);
    if (!sheet) { missingBox(dx, dy, dw, dh); return; }
    if (e.alpha <= 0.01) return;
    fx.save();
    fx.globalAlpha = e.alpha;
    if (e.flash > 0) drawTinted(sheet, frame * a.cw, 0, a.cw, a.ch, dx, dy, dw, dh, false, '#fff2c0');
    else paintCell(sheet, frame * a.cw, 0, a.cw, a.ch, dx, dy, dw, dh, false);
    fx.restore();
    drawEnemyHp(e, K);
  }

  // 小怪头顶血条（只有杂兵显示，BOSS 用 HUD 上的大血条）
  function drawEnemyHp(e, K) {
    if (e.kind !== 'skeleton') return;
    if (e.state === 'death' || e.state === 'dead') return;
    const k = depthK(e.feetY);
    const w = 42, h = 4;
    const x = Math.round(e.x - w / 2);
    const y = Math.round(e.feetY - K.bodyH * k - 8);
    fx.save();
    fx.globalAlpha = e.alpha;
    fx.fillStyle = 'rgba(6,9,14,.82)';
    fx.fillRect(x - 1, y - 1, w + 2, h + 2);
    fx.fillStyle = '#3a2b2b';
    fx.fillRect(x, y, w, h);
    const ratio = Math.max(0, e.hp / e.maxhp);
    if (ratio > 0) {
      fx.fillStyle = '#e0705f';
      fx.fillRect(x, y, Math.max(1, Math.round(w * ratio)), h);
    }
    fx.strokeStyle = 'rgba(216,201,165,.5)';
    fx.lineWidth = 1;
    fx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    fx.restore();
  }

  function updateSparks(dt) {
    const arr = G.sparks;
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      s.t += dt;
      if (s.t < s.dur) arr[n++] = s;
    }
    arr.length = n;
  }

  function drawSparks() {
    for (const s of G.sparks) {
      const q = s.t / s.dur;
      if (q >= 1) continue;
      const Rr = 5 + 36 * q;
      fx.save();
      fx.globalAlpha = (1 - q) * 0.95;
      fx.strokeStyle = s.color; fx.lineWidth = Math.max(1, 3 * (1 - q));
      for (let i = 0; i < 9; i++) {
        const ang = i * Math.PI * 2 / 9 + s.seed;
        const r0 = Rr * 0.34, r1 = Rr * (0.85 + 0.3 * Math.sin(i * 2.7 + s.seed));
        fx.beginPath();
        fx.moveTo(s.x + Math.cos(ang) * r0, s.y + Math.sin(ang) * r0 * 0.8);
        fx.lineTo(s.x + Math.cos(ang) * r1, s.y + Math.sin(ang) * r1 * 0.8);
        fx.stroke();
      }
      fx.beginPath(); fx.ellipse(s.x, s.y, Rr, Rr * 0.78, 0, 0, Math.PI * 2); fx.stroke();
      fx.fillStyle = '#ffffff'; fx.globalAlpha = (1 - q) * 0.9;
      fx.beginPath(); fx.arc(s.x, s.y, Math.max(1, 8 * (1 - q)), 0, Math.PI * 2); fx.fill();
      fx.restore();
    }
  }

  /* ---------------- HUD ---------------- */
  const GRAD = new Map();
  function gradFor(key, x, y, h, c1, c2) {
    let g = GRAD.get(key);
    if (!g) { g = ux.createLinearGradient(x, y, x, y + h); g.addColorStop(0, c1); g.addColorStop(1, c2); GRAD.set(key, g); }
    return g;
  }

  function bar(x, y, w, h, ratio, c1, c2, label, key) {
    ux.fillStyle = '#0c1118'; ux.fillRect(x - 1, y - 1, w + 2, h + 2);
    ux.fillStyle = '#3a2b2b'; ux.fillRect(x, y, w, h);
    const ww = Math.max(0, Math.round(w * clamp(ratio, 0, 1)));
    if (ww > 0) { ux.fillStyle = gradFor(key, x, y, h, c1, c2); ux.fillRect(x, y, ww, h); }
    ux.strokeStyle = '#d8c9a5'; ux.lineWidth = 1; ux.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (label) {
      ux.fillStyle = '#fff'; ux.font = '10px monospace'; ux.textAlign = 'left';
      ux.fillText(label, x + 4, y + h - 2);
    }
  }

  function roundRect(x, y, w, h, r) {
    ux.beginPath();
    if (typeof ux.roundRect === 'function') ux.roundRect(x, y, w, h, r);
    else ux.rect(x, y, w, h);
  }

  function drawArrow(t) {
    const pulse = 0.62 + 0.38 * Math.sin(t * 4.2);
    const x0 = W - 134, y0 = 122, aw = 124, ah = 110;
    // 右侧出口光带
    const g = ux.createLinearGradient(W - 30, 0, W, 0);
    g.addColorStop(0, 'rgba(245,194,107,0)');
    g.addColorStop(1, 'rgba(245,194,107,' + (0.42 * pulse).toFixed(3) + ')');
    ux.fillStyle = g; ux.fillRect(W - 30, 28, 30, H - 50);

    ux.save();
    // 底板：亮地图上也能看清
    ux.fillStyle = 'rgba(10,13,19,.76)';
    roundRect(x0, y0, aw, ah, 10); ux.fill();
    ux.strokeStyle = 'rgba(245,194,107,.6)'; ux.lineWidth = 1.5;
    roundRect(x0 + 0.75, y0 + 0.75, aw - 1.5, ah - 1.5, 10); ux.stroke();

    ux.textAlign = 'center';
    ux.fillStyle = '#f5c26b'; ux.font = 'bold 14px "Microsoft YaHei",monospace';
    ux.fillText('向右走', x0 + aw / 2, y0 + 30);
    ux.fillStyle = '#b9c4d2'; ux.font = '11px "Microsoft YaHei",monospace';
    ux.fillText('走出地图', x0 + aw / 2, y0 + 48);

    const ax = x0 + aw / 2 + 8 + Math.sin(t * 3.2) * 5;
    ux.globalAlpha = pulse;
    ux.fillStyle = '#f5c26b';
    ux.beginPath();
    ux.moveTo(ax + 24, y0 + 84);
    ux.lineTo(ax - 14, y0 + 64);
    ux.lineTo(ax - 14, y0 + 76);
    ux.lineTo(ax - 30, y0 + 76);
    ux.lineTo(ax - 30, y0 + 92);
    ux.lineTo(ax - 14, y0 + 92);
    ux.lineTo(ax - 14, y0 + 104);
    ux.closePath(); ux.fill();
    ux.restore();
  }

  function drawBanner() {
    const b = G.banner;
    if (!b) return;
    const q = b.t / b.dur;
    const fade = q < 0.12 ? q / 0.12 : (q > 0.72 ? (1 - q) / 0.28 : 1);
    ux.save();
    ux.globalAlpha = Math.max(0, Math.min(1, fade));
    ux.fillStyle = 'rgba(10,13,19,.62)'; ux.fillRect(0, 120, W, 66);
    ux.strokeStyle = 'rgba(245,194,107,.55)'; ux.lineWidth = 1;
    ux.beginPath(); ux.moveTo(0, 120.5); ux.lineTo(W, 120.5); ux.stroke();
    ux.beginPath(); ux.moveTo(0, 185.5); ux.lineTo(W, 185.5); ux.stroke();
    ux.fillStyle = '#f5c26b'; ux.font = 'bold 20px "Microsoft YaHei",monospace'; ux.textAlign = 'center';
    ux.fillText(b.title, W / 2, 152);
    if (b.sub) {
      ux.fillStyle = '#c3ccd9'; ux.font = '12px "Microsoft YaHei",monospace';
      ux.fillText(b.sub, W / 2, 174);
    }
    ux.restore();
  }

  let hudT = 1;
  function drawHUD() {
    const p = G.player, z = ZONES[G.zone];
    ux.clearRect(0, 0, W, H);

    // 顶部标题
    ux.fillStyle = 'rgba(12,16,22,.72)'; ux.fillRect(0, 0, W, 28);
    ux.fillStyle = '#f5c26b'; ux.font = 'bold 13px "Microsoft YaHei",monospace'; ux.textAlign = 'center';
    ux.fillText('第 ' + z.id + ' 区 · ' + z.name, W / 2, 19);
    ux.fillStyle = '#8d99ab'; ux.font = '10px monospace'; ux.textAlign = 'right';
    ux.fillText(G.zone === 1 ? 'BOSS 战' : '清场推进', W - 10, 19);

    // 左：玩家（面板留够高度，避免状态行被下边缘切掉）
    ux.fillStyle = 'rgba(12,16,22,.68)'; ux.fillRect(8, 34, 236, 64);
    ux.strokeStyle = '#4a5566'; ux.lineWidth = 1; ux.strokeRect(8.5, 34.5, 235, 63);
    if (IMG.portrait) {
      if (IMG.portraitIsAvatar) {
        // 开始界面选的方图：整张等比塞进 50×50 头像位
        ux.drawImage(IMG.portrait, 0, 0, IMG.portrait.width, IMG.portrait.height, 13, 39, 50, 50);
      } else {
        // 按比例裁（原图 1024×1536 里取 230,120,564,564），这样换成缩略图也不会裁空
        ux.drawImage(IMG.portrait,
          IMG.portrait.width * 0.2246, IMG.portrait.height * 0.0781,
          IMG.portrait.width * 0.5508, IMG.portrait.height * 0.3672,
          13, 39, 50, 50);
      }
    }
    ux.fillStyle = '#e6ebf3'; ux.font = 'bold 11px "Microsoft YaHei",monospace'; ux.textAlign = 'left';
    ux.fillText('小雨', 70, 50);
    bar(70, 55, 166, 11, p.hp / p.maxhp, '#f07a63', '#a72f2a', 'HP ' + p.hp + ' / ' + p.maxhp, 'php');
    bar(70, 70, 166, 7, 1, '#f5d472', '#c08a2c', '', 'penergy');
    ux.fillStyle = '#9aa7ba'; ux.font = '10px monospace';
    const pf = (p.state === 'punch' || p.state === 'walk') ? p.frame : 0;
    const nth = (G.groupIdx + 1) + '/' + GROUP_COUNT;
    ux.fillText(p.state.toUpperCase() + ' · ' + p.side + '向 · ' +
      (p.state === 'punch' ? 'F' + pf + '/51 · 第 ' + nth + ' 拳' : 'F' + pf + ' · 下一拳 ' + nth), 70, 88);

    // 右：波次 / BOSS
    ux.fillStyle = 'rgba(12,16,22,.68)'; ux.fillRect(W - 218, 34, 210, 48);
    ux.strokeStyle = '#4a5566'; ux.strokeRect(W - 217.5, 34.5, 209, 47);
    const boss = G.enemies.find((e) => e.kind === 'boss');
    if (G.zone === 1) {
      ux.fillStyle = '#e6ebf3'; ux.font = 'bold 11px "Microsoft YaHei",monospace'; ux.textAlign = 'left';
      ux.fillText('BOSS ' + KINDS.boss.name, W - 208, 50);
      bar(W - 208, 55, 190, 12, boss ? boss.hp / boss.maxhp : 1, '#e88b6a', '#8d2f28',
        boss ? 'HP ' + boss.hp + ' / ' + boss.maxhp : '登场中…', 'boss');
      ux.fillStyle = '#8d99ab'; ux.font = '10px monospace';
      ux.fillText(gBossPhase(), W - 208, 77);
    } else if (G.zone === 0) {
      ux.fillStyle = '#e6ebf3'; ux.font = 'bold 12px "Microsoft YaHei",monospace'; ux.textAlign = 'left';
      const wv = G.phase === 'clear' ? '已清空' : '第 ' + Math.min(G.wave + 1, ZONE1_WAVES.length) + ' / ' + ZONE1_WAVES.length + ' 波';
      ux.fillText(wv, W - 208, 52);
      ux.fillStyle = '#8d99ab'; ux.font = '10px monospace';
      ux.fillText('剩余敌人 ' + aliveCount() + ' · 已击破 ' + G.kills, W - 208, 70);
    } else {
      ux.fillStyle = '#8d99ab'; ux.font = 'bold 12px "Microsoft YaHei",monospace'; ux.textAlign = 'left';
      ux.fillText('空场景', W - 208, 52);
      ux.font = '10px monospace';
      ux.fillText('按 1 / 2 回到关卡', W - 208, 70);
    }

    if (G.zone === 0 && G.phase === 'clear') drawArrow(performance.now() / 1000);
    drawBanner();

    if (MISSING.length) {
      ux.fillStyle = 'rgba(120,30,26,.9)'; ux.fillRect(0, 28, W, 26);
      ux.fillStyle = '#ffd9d3'; ux.font = '11px "Microsoft YaHei",monospace'; ux.textAlign = 'center';
      ux.fillText('素材未加载 ' + MISSING.length + ' 个 — 请用 127.0.0.1:8772/battle_demo/index.html', W / 2, 45);
    }
  }

  function gBossPhase() {
    if (G.phase === 'clear') return '已击破';
    const b = G.enemies.find((e) => e.kind === 'boss');
    if (!b) return '登场中…';
    return b.state === 'attack' ? '发动攻击' : (b.state === 'hurt' ? '受创' : '逼近中');
  }

  function paintBg() {
    if (bgZone === G.zone) return;
    bgZone = G.zone;
    bx.setTransform(R, 0, 0, R, 0, 0);
    bx.clearRect(0, 0, W, H);
    if (IMG.zones[G.zone]) bx.drawImage(IMG.zones[G.zone], 0, 0, W, H);
    else { bx.fillStyle = '#26313f'; bx.fillRect(0, 0, W, H); }
  }

  function render(dt) {
    paintBg();
    fx.setTransform(R, 0, 0, R, 0, 0);
    fx.clearRect(0, 0, W, H);
    fx.save();
    if (G.shake > 0.2) fx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake * 0.6);

    // 按脚底 Y 排序，实现前后遮挡
    const list = [{ feetY: G.player.feetY, isPlayer: true, ref: null }];
    for (const e of G.enemies) list.push({ feetY: e.feetY, isPlayer: false, ref: e });
    list.sort((a, b) => a.feetY - b.feetY);
    for (const it of list) { if (it.isPlayer) drawPlayer(); else drawEnemy(it.ref); }
    drawSparks();
    fx.restore();

    if (G.fade > 0.001) {
      fx.setTransform(R, 0, 0, R, 0, 0);
      fx.fillStyle = 'rgba(6,8,12,' + G.fade.toFixed(3) + ')';
      fx.fillRect(0, 0, W, H);
    }

    hudT += dt;
    if (hudT >= 1 / CFG.hudHz) {
      hudT = 0;
      ux.setTransform(R, 0, 0, R, 0, 0);
      drawHUD();
    }
  }

  /* ==================== 主循环 ==================== */
  let last = 0;
  function loop(now) {
    let dt;
    if (STEP) dt = Math.min(0.5, Math.max(0.001, parseFloat(STEP) || 1 / 60));
    else {
      if (!last) last = now;
      dt = Math.min(0.05, (now - last) / 1000);
      last = now;
    }

    if (G.hitStop > 0) { G.hitStop -= dt; dt = 0; }
    if (dt > 0) {
      G.player.flash = Math.max(0, G.player.flash - dt * 2);
      G.player.knock -= G.player.knock * Math.min(1, dt * 9);
      G.shake -= G.shake * Math.min(1, dt * 12);
      G.fade = Math.max(0, G.fade - dt * 2.6);
      updateMove(dt);
      advancePlayer(dt);
      updateFlow(dt);
      updateEnemies(dt);
      updateSparks(dt);
    }
    render(dt);
    requestAnimationFrame(loop);
  }

  /* ==================== 交互 ==================== */
  function setZone(i) {
    G.zone = ((i % ZONES.length) + ZONES.length) % ZONES.length;
    G.fade = 1;
    resetZone();
  }

  function toggleBgm() {
    G.bgm = !G.bgm;
    if (G.bgm) audio.play().catch(() => { G.bgm = false; });
    else audio.pause();
    const b = $('#btnBgm'); if (b) b.classList.toggle('on', G.bgm);
  }

  const KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', d: 'right', w: 'up', s: 'down', A: 'left', D: 'right', W: 'up', S: 'down'
  };
  window.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (KEYMAP[k]) { G.keys[KEYMAP[k]] = true; ev.preventDefault(); return; }
    if (k === 'j' || k === 'J' || k === ' ') { attackOnce(); ev.preventDefault(); return; }
    if (k >= '1' && k <= '6') { setZone(parseInt(k, 10) - 1); return; }
    if (k === 'r' || k === 'R') { resetZone(); return; }
    if (k === 'm' || k === 'M') { toggleBgm(); return; }
  });
  window.addEventListener('keyup', (ev) => { if (KEYMAP[ev.key]) G.keys[KEYMAP[ev.key]] = false; });
  window.addEventListener('blur', () => { G.keys = {}; });

  // 页面可能被精简成"只有画面"，所有按钮都做存在性判断
  const bind = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  bind('#btnStep', attackOnce);
  bind('#btnZonePrev', () => setZone(G.zone - 1));
  bind('#btnZoneNext', () => setZone(G.zone + 1));
  bind('#btnBgm', toggleBgm);
  bind('#btnReset', resetZone);

  window.addEventListener('error', (ev) => {
    const el = $('#status');
    if (el) el.innerHTML = '<span style="color:#e2584d">脚本异常：' +
      String(ev.message || '未知错误').replace(/[<>]/g, '') + '</span>';
  });

  /* ==================== 触屏操作（手机） ==================== */
  function initTouchUI() {
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (!isTouch || document.querySelector('.tc-layer')) return;

    const layer = document.createElement('div');
    layer.className = 'tc-layer';
    layer.innerHTML =
      '<div class="tc-zone"></div>' +
      '<div class="tc-stick"><i></i></div>' +
      '<button class="tc-btn tc-punch" type="button">拳</button>' +
      '<button class="tc-btn tc-reset" type="button">重来</button>';
    (document.getElementById('app') || document.body).appendChild(layer);

    const zone = layer.querySelector('.tc-zone');
    const stick = layer.querySelector('.tc-stick');
    const knob = stick.querySelector('i');
    const R = 46;                       // 摇杆最大位移
    let pid = null, cx = 0, cy = 0;

    const clearKeys = () => { G.keys.left = G.keys.right = G.keys.up = G.keys.down = false; };

    function center() {
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    // 竖屏时整块画面被旋转了 90°，摇杆向量要反向旋转回局部坐标
    const isRotated = () => window.matchMedia('(orientation:portrait) and (pointer:coarse)').matches;

    function apply(x, y) {
      let dx = x - cx, dy = y - cy;
      if (isRotated()) { const t = dx; dx = dy; dy = -t; }
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / R);
      knob.style.transform = 'translate(calc(-50% + ' + (dx / len * R * k).toFixed(1) +
        'px), calc(-50% + ' + (dy / len * R * k).toFixed(1) + 'px))';
      const nx = dx / len, ny = dy / len, dead = len < 10;
      G.keys.left = !dead && nx < -0.4;
      G.keys.right = !dead && nx > 0.4;
      G.keys.up = !dead && ny < -0.4;
      G.keys.down = !dead && ny > 0.4;
    }
    function end(ev) {
      if (pid === null || ev.pointerId !== pid) return;
      pid = null;
      stick.classList.remove('on');
      knob.style.transform = 'translate(-50%,-50%)';
      clearKeys();
    }

    zone.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      pid = ev.pointerId;
      try { zone.setPointerCapture(pid); } catch (e) { /* 忽略 */ }
      center();
      stick.classList.add('on');
      apply(ev.clientX, ev.clientY);
    });
    zone.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== pid) return;
      ev.preventDefault();
      apply(ev.clientX, ev.clientY);
    });
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    layer.querySelector('.tc-punch').addEventListener('pointerdown', (ev) => { ev.preventDefault(); attackOnce(); });
    layer.querySelector('.tc-reset').addEventListener('pointerdown', (ev) => { ev.preventDefault(); resetZone(); });

    // 转屏时把摇杆状态复位，避免按键卡住
    window.addEventListener('orientationchange', () => { pid = null; stick.classList.remove('on'); clearKeys(); });
  }

  /* ==================== 启动 ==================== */
  const ticker = setInterval(() => {
    const el = $('#status');
    if (el) el.textContent = '资源加载中 ' + doneCount + ' / ' + JOBS.length + ' …';
  }, 120);

  Promise.all(JOBS).then(() => {
    clearInterval(ticker);
    const msg = '<b>运行中</b> · v16 · 已加载 ' + JOBS.length + ' 个现有素材 · ' +
      (MISSING.length ? '<span style="color:#e2584d">缺失 ' + MISSING.length + ' 个：' + MISSING.slice(0, 3).join('、') + '</span>' : '无缺失');
    const st = $('#status');
    if (st) st.innerHTML = msg + '<br><span style="color:#8d99ab">第 1 区 3 波骷髅 → 清空后走到右边缘换图 → 第 2 区 BOSS 小恶魔</span>';
    if (PRESS > 0) G.groupIdx = (G.groupIdx + PRESS) % GROUP_COUNT;
    if (GROUP >= 0) { G.groupIdx = GROUP % GROUP_COUNT; attackOnce(); }
    initTouchUI();                          // 手机上挂摇杆/出拳键
    if (QS.get('debug')) window.__G = G;   // 自动化验证用
    requestAnimationFrame(loop);
  });
})();
