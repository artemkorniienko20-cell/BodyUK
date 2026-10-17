import * as THREE from 'three';
import { TacticalShadersFactory } from './materials.js';

/**
 * Генератор тактичних локацій та систем декалей/частинок Niagara у стилі UE5
 */
export class TacticalEnvironment {
  constructor(scene) {
    this.scene = scene;
    this.shaderFactory = new TacticalShadersFactory();
    this.colliders = [];
    this.puddleZones = [];
    this.brightZones = [];
    this.impactDecals = [];
    this.bloodDecals = [];
    this.particles = [];
    this.shellCasings = [];

    this.currentMapIndex = 0;
    this.mapDefinitions = [
      {
        id: 'day_forest',
        name: 'DAY FOREST // ДЕННИЙ ЛІС',
        isNight: false,
        skyColor: 0xd8ecff,
        fogColor: 0xcfe4f7,
        fogDensity: 0.011,
        sunColor: 0xfff7e2,
        sunIntensity: 4.2,
        hemiSky: 0xdff0ff,
        hemiGround: 0x6e785c,
        hemiIntensity: 1.85
      },
      {
        id: 'night_forest',
        name: 'NIGHT FOREST // НІЧНИЙ ЛІС',
        isNight: true,
        skyColor: 0x050911,
        fogColor: 0x060b14,
        fogDensity: 0.024,
        sunColor: 0x6b92c8,
        sunIntensity: 0.55,
        hemiSky: 0x1a283b,
        hemiGround: 0x0b120e,
        hemiIntensity: 0.42
      },
      {
        id: 'warehouse',
        name: 'SUNLIT WAREHOUSE // СВІТЛИЙ АНГАР',
        isNight: false,
        skyColor: 0xe8f2fc,
        fogColor: 0xdce8f4,
        fogDensity: 0.012,
        sunColor: 0xffffff,
        sunIntensity: 4.0,
        hemiSky: 0xffffff,
        hemiGround: 0x8a929a,
        hemiIntensity: 1.95
      },
      {
        id: 'rooftop',
        name: 'ROOFTOP HELIPAD // ДАХ ХМАРОЧОСА',
        isNight: false,
        skyColor: 0xc2e2ff,
        fogColor: 0xc8e4ff,
        fogDensity: 0.009,
        sunColor: 0xfff9eb,
        sunIntensity: 4.5,
        hemiSky: 0xd4ebff,
        hemiGround: 0x8d959e,
        hemiIntensity: 2.0
      },
      {
        id: 'desert',
        name: 'DESERT COMPOUND // ПУСТЕЛЬНА БАЗА',
        isNight: false,
        skyColor: 0xfff0d4,
        fogColor: 0xf5e3c2,
        fogDensity: 0.012,
        sunColor: 0xffeec2,
        sunIntensity: 4.8,
        hemiSky: 0xfff6e0,
        hemiGround: 0xb89c72,
        hemiIntensity: 1.9
      }
    ];

    this.textures = this.generateProceduralTextures();
    this.levelGroup = new THREE.Group();
    this.scene.add(this.levelGroup);
    this.lightsGroup = new THREE.Group();
    this.scene.add(this.lightsGroup);

    this.loadMap(0);
  }

  generateProceduralTextures() {
    const makeCanvasTex = (drawFn, repeatX = 1, repeatY = 1) => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      drawFn(ctx, 512, 512);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeatX, repeatY);
      return tex;
    };

    // 1. Світлий бетон для ангара та даху
    const concreteBright = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#9aa0a6';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 8000; i++) {
        const v = 135 + Math.floor(Math.random() * 45);
        ctx.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      ctx.strokeStyle = 'rgba(70,74,78,0.45)';
      ctx.lineWidth = 2;
      for (let g = 0; g <= w; g += 128) {
        ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(w, g); ctx.stroke();
      }
    }, 8, 8);

    // 2. Лісовий ґрунт з травою та хвоєю
    const forestGround = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#5c6b48';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 9500; i++) {
        const isGrass = Math.random() > 0.38;
        ctx.fillStyle = isGrass
          ? `rgb(${75 + Math.floor(Math.random() * 35)}, ${98 + Math.floor(Math.random() * 42)}, ${55 + Math.floor(Math.random() * 25)})`
          : `rgb(${95 + Math.floor(Math.random() * 35)}, ${78 + Math.floor(Math.random() * 28)}, ${52 + Math.floor(Math.random() * 20)})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
      }
    }, 10, 10);

    // 3. Світла фанера / OSB щити для полігону страйкболу
    const plywood = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#c4a472';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 6000; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(165, 130, 82, 0.35)' : 'rgba(215, 185, 135, 0.35)';
        ctx.fillRect(Math.random() * w, Math.random() * h, 8, 3);
      }
      ctx.strokeStyle = 'rgba(85, 62, 35, 0.5)';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, w - 4, h - 4);
    }, 1, 1);

    // 4. Сонячний пісок та пісковик для пустельної бази
    const sandTex = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#d8be92';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 8500; i++) {
        const v = 195 + Math.floor(Math.random() * 45);
        ctx.fillStyle = `rgb(${v}, ${v - 22}, ${v - 58})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    }, 8, 8);

    const sandstoneWall = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#cfb284';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(130, 102, 66, 0.45)';
      ctx.lineWidth = 3;
      for (let y = 0; y < h; y += 64) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        for (let x = (y % 128 === 0 ? 0 : 64); x < w; x += 128) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 64); ctx.stroke();
        }
      }
    }, 2, 2);

    // 5. Біла цегла / побілені стіни ангара
    const whiteBrick = makeCanvasTex((ctx, w, h) => {
      ctx.fillStyle = '#d4dae0';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#aeb6bf';
      ctx.lineWidth = 2;
      for (let y = 0; y < h; y += 32) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      ctx.fillStyle = '#3b6ea5';
      ctx.fillRect(0, 360, w, 36);
    }, 2, 1);

    return {
      concreteBright,
      forestGround,
      plywood,
      sandTex,
      sandstoneWall,
      whiteBrick
    };
  }

  /**
   * Очищення поточної карти та побудова локації за індексом (0..4)
   */
  loadMap(mapIndex) {
    this.currentMapIndex = ((mapIndex % this.mapDefinitions.length) + this.mapDefinitions.length) % this.mapDefinitions.length;
    const def = this.mapDefinitions[this.currentMapIndex];

    while (this.levelGroup.children.length > 0) {
      this.levelGroup.remove(this.levelGroup.children[0]);
    }
    while (this.lightsGroup.children.length > 0) {
      this.lightsGroup.remove(this.lightsGroup.children[0]);
    }
    for (const d of this.impactDecals) this.scene.remove(d);
    for (const bd of this.bloodDecals) this.scene.remove(bd.mesh);
    this.impactDecals = [];
    this.bloodDecals = [];
    this.colliders = [];
    this.puddleZones = [];
    this.brightZones = [];

    this.scene.background = new THREE.Color(def.skyColor);
    this.scene.fog = new THREE.FogExp2(def.fogColor, def.fogDensity);

    const hemi = new THREE.HemisphereLight(def.hemiSky, def.hemiGround, def.hemiIntensity);
    hemi.position.set(0, 25, 0);
    this.lightsGroup.add(hemi);

    const sun = new THREE.DirectionalLight(def.sunColor, def.sunIntensity);
    sun.position.set(14, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 70;
    const d = 24;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    this.lightsGroup.add(sun);

    const bounceLight = new THREE.DirectionalLight(def.isNight ? 0x223855 : 0xffffff, def.isNight ? 0.25 : 1.35);
    bounceLight.position.set(-12, 16, -14);
    this.lightsGroup.add(bounceLight);

    // Побудова геометрії конкретної карти
    if (this.currentMapIndex === 0) {
      this.buildDayForestMap();
    } else if (this.currentMapIndex === 1) {
      this.buildNightForestMap();
    } else if (this.currentMapIndex === 2) {
      this.buildSunlitWarehouseMap();
    } else if (this.currentMapIndex === 3) {
      this.buildRooftopHelipadMap();
    } else {
      this.buildDesertCompoundMap();
    }

    this.brightZones = [
      new THREE.Vector3(0, 6.0, -14),
      new THREE.Vector3(8, 6.0, 0),
      new THREE.Vector3(-8, 6.0, 0)
    ];

    return def;
  }

  addColliderBox(x, y, z, w, h, d, mat, isCollider = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.levelGroup.add(mesh);
    if (isCollider) {
      const box = new THREE.Box3().setFromObject(mesh);
      this.colliders.push({ box, mesh });
    }
    return mesh;
  }

  addPerimeterWalls(sizeX = 32, sizeZ = 36, wallHeight = 3.6, mat) {
    const halfX = sizeX * 0.5;
    const halfZ = sizeZ * 0.5;
    this.addColliderBox(0, wallHeight * 0.5, halfZ, sizeX, wallHeight, 0.6, mat);
    this.addColliderBox(0, wallHeight * 0.5, -halfZ, sizeX, wallHeight, 0.6, mat);
    this.addColliderBox(-halfX, wallHeight * 0.5, 0, 0.6, wallHeight, sizeZ, mat);
    this.addColliderBox(halfX, wallHeight * 0.5, 0, 0.6, wallHeight, sizeZ, mat);
  }

  addReflectivePuddles(coords) {
    const puddleMat = new THREE.MeshStandardMaterial({
      color: 0x5c7d96,
      roughness: 0.04,
      metalness: 0.85,
      transparent: true,
      opacity: 0.65
    });
    for (const p of coords) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 24), puddleMat);
      m.scale.set(p.w * 0.5, p.d * 0.5, 1);
      m.rotation.x = -Math.PI / 2;
      m.position.set(p.x, 0.012, p.z);
      this.levelGroup.add(m);
      this.puddleZones.push(p);
    }
  }

  addInvisibleForestBounds(sizeX = 32, sizeZ = 36, wallHeight = 5.0) {
    const halfX = sizeX * 0.5;
    const halfZ = sizeZ * 0.5;
    const invisMat = new THREE.MeshBasicMaterial({ visible: false });
    this.addColliderBox(0, wallHeight * 0.5, halfZ, sizeX, wallHeight, 0.8, invisMat, true);
    this.addColliderBox(0, wallHeight * 0.5, -halfZ, sizeX, wallHeight, 0.8, invisMat, true);
    this.addColliderBox(-halfX, wallHeight * 0.5, 0, 0.8, wallHeight, sizeZ, invisMat, true);
    this.addColliderBox(halfX, wallHeight * 0.5, 0, 0.8, wallHeight, sizeZ, invisMat, true);
  }

  /**
   * Побудова спільного природного лісового ландшафту (без штучних стін по периметру):
   * густий сосново-березовий ліс на 360°, повалені колоди, замшілі валуни, кущі та зруб лісника.
   */
   populateNaturalWoodland(isNight = false) {
    // Безшовна широка лісова галявина, що йде далеко за горизонт (120x120 м)
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.textures.forestGround,
      color: isNight ? 0x263328 : 0xb8d49e,
      roughness: 0.88,
      metalness: 0.04
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.levelGroup.add(floor);

    // Невидимі фізичні межі галявини (замість штучних бетонних/фанерних стін!)
    this.addInvisibleForestBounds(33, 36, 5.0);

    const pineBarkMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x241911 : 0x5c3e26,
      roughness: 0.92
    });
    const birchBarkMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x6e7378 : 0xe2e4e6,
      roughness: 0.78
    });
    const pineNeedlesMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x0d2116 : 0x285e32,
      roughness: 0.82
    });
    const birchLeavesMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x162e1c : 0x528c3a,
      roughness: 0.78
    });
    const bushMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x102618 : 0x386e2e,
      roughness: 0.86
    });
    const boulderMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x2b3238 : 0x6b7278,
      roughness: 0.92
    });
    const cabinLogMat = new THREE.MeshStandardMaterial({
      color: isNight ? 0x2e2015 : 0x6e4a2c,
      roughness: 0.88
    });

    // 1. Тактичні дерева всередині бойової лісової зони (товсті стовбури, за якими можна ховатися й виглядати Q/E)
    const innerTrees = [
      // Південна частина лісу
      { x: -6.2, z: 10.5, r: 0.48, h: 6.5, birch: false },
      { x: 6.2, z: 10.5, r: 0.46, h: 6.2, birch: true },
      { x: -2.6, z: 8.8, r: 0.42, h: 5.8, birch: false },
      { x: 2.8, z: 8.5, r: 0.44, h: 6.0, birch: false },
      { x: -9.5, z: 6.5, r: 0.50, h: 6.8, birch: true },
      { x: 9.5, z: 6.2, r: 0.52, h: 7.0, birch: false },
      // Центральна хаща лісу
      { x: -5.4, z: 3.4, r: 0.48, h: 6.4, birch: false },
      { x: 5.4, z: 3.2, r: 0.45, h: 6.2, birch: true },
      { x: -8.8, z: 0.0, r: 0.52, h: 7.2, birch: false },
      { x: 8.8, z: 0.0, r: 0.50, h: 6.8, birch: false },
      { x: -5.4, z: -3.4, r: 0.46, h: 6.3, birch: true },
      { x: 5.4, z: -3.2, r: 0.48, h: 6.5, birch: false },
      // Північна частина лісу
      { x: -2.6, z: -8.6, r: 0.44, h: 6.0, birch: true },
      { x: 2.8, z: -8.8, r: 0.45, h: 6.2, birch: false },
      { x: -6.2, z: -10.5, r: 0.48, h: 6.6, birch: false },
      { x: 6.2, z: -10.5, r: 0.48, h: 6.4, birch: true },
      { x: -9.5, z: -6.5, r: 0.52, h: 7.0, birch: false },
      { x: 9.5, z: -6.5, r: 0.50, h: 6.8, birch: true }
    ];

    for (const t of innerTrees) {
      this.spawnDetailedTree(
        t.x,
        t.z,
        t.r,
        t.h,
        t.birch ? birchBarkMat : pineBarkMat,
        t.birch ? birchLeavesMat : pineNeedlesMat,
        t.birch,
        true
      );
    }

    // 2. Густе кільце віковічного лісу навколо галявини (75+ дерев у кілька рядів — створює справжній глибокий ліс!)
    for (let i = 0; i < 76; i++) {
      const angle = (i / 76) * Math.PI * 2;
      const ringOffset = (i % 3) * 3.8;
      const tx = Math.cos(angle) * (17.2 + ringOffset) + Math.sin(i * 7.3) * 1.2;
      const tz = Math.sin(angle) * (19.0 + ringOffset) + Math.cos(i * 5.1) * 1.2;
      const isBirch = i % 4 === 0;
      const radius = 0.36 + (i % 3) * 0.08;
      const height = 5.8 + (i % 4) * 1.1;
      this.spawnDetailedTree(
        tx,
        tz,
        radius,
        height,
        isBirch ? birchBarkMat : pineBarkMat,
        isBirch ? birchLeavesMat : pineNeedlesMat,
        isBirch,
        false
      );
    }

    // 3. Зруб старого лісового будиночка / мисливської засіки в центрі лісу (з колод)
    this.addColliderBox(-2.9, 1.15, 0.0, 0.45, 2.3, 4.6, cabinLogMat, true);
    this.addColliderBox(2.9, 1.15, 0.0, 0.45, 2.3, 4.6, cabinLogMat, true);
    this.addColliderBox(0.0, 0.58, 2.3, 3.2, 1.16, 0.45, cabinLogMat, true);
    this.addColliderBox(0.0, 0.58, -2.3, 3.2, 1.16, 0.45, cabinLogMat, true);

    // 4. Повалені вікові стовбури дерев (повалені колоди на землі для тактичних укриттів)
    const fallenLogs = [
      { x: 0.0, z: 7.2, len: 4.4, rotY: 0.18 },
      { x: -4.8, z: 6.2, len: 3.6, rotY: -0.52 },
      { x: 4.8, z: 6.0, len: 3.6, rotY: 0.48 },
      { x: 0.0, z: -7.2, len: 4.4, rotY: -0.22 },
      { x: -4.8, z: -6.2, len: 3.6, rotY: 0.55 },
      { x: 4.8, z: -6.0, len: 3.6, rotY: -0.45 },
      { x: -11.2, z: 2.8, len: 3.8, rotY: 1.35 },
      { x: 11.2, z: -2.8, len: 3.8, rotY: -1.35 }
    ];
    for (const fl of fallenLogs) {
      const logMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, fl.len, 10), pineBarkMat);
      logMesh.rotation.z = Math.PI / 2;
      logMesh.rotation.y = fl.rotY;
      logMesh.position.set(fl.x, 0.42, fl.z);
      logMesh.castShadow = true;
      logMesh.receiveShadow = true;
      this.levelGroup.add(logMesh);
      const box = new THREE.Box3().setFromObject(logMesh);
      this.colliders.push({ box, mesh: logMesh });
    }

    // 5. Замшілі лісові валуни та скельні виступи
    const boulders = [
      { x: -3.4, z: 11.4, r: 0.95 },
      { x: 3.4, z: 11.2, r: 0.90 },
      { x: -7.6, z: 2.2, r: 1.05 },
      { x: 7.6, z: -2.2, r: 1.05 },
      { x: -7.6, z: -2.4, r: 0.92 },
      { x: 7.6, z: 2.4, r: 0.92 },
      { x: -3.4, z: -11.4, r: 0.95 },
      { x: 3.4, z: -11.2, r: 0.90 }
    ];
    for (const b of boulders) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(b.r, 1), boulderMat);
      rock.scale.set(1.25, 0.85, 1.1);
      rock.position.set(b.x, b.r * 0.65, b.z);
      rock.rotation.set(b.x, b.z, 0.4);
      rock.castShadow = true;
      rock.receiveShadow = true;
      this.levelGroup.add(rock);
      const box = new THREE.Box3().setFromObject(rock);
      this.colliders.push({ box, mesh: rock });
    }

    // 6. Лісові кущі та папороть (візуальна рослинність без блокування руху)
    for (let i = 0; i < 42; i++) {
      const bx = Math.sin(i * 14.3) * 13.8;
      const bz = Math.cos(i * 9.7) * 15.2;
      if (Math.abs(bx) < 2.2 && Math.abs(bz) > 11.5) continue; // Не закривати точку старту
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55 + (i % 3) * 0.22, 1), bushMat);
      bush.scale.set(1.3, 0.75, 1.3);
      bush.position.set(bx, 0.38, bz);
      bush.castShadow = true;
      this.levelGroup.add(bush);
    }

    // Лісові калюжі після дощу
    this.addReflectivePuddles([
      { x: 0, z: 4.8, w: 3.8, d: 2.6 },
      { x: -3.8, z: -4.2, w: 4.0, d: 2.8 },
      { x: 3.8, z: 4.0, w: 3.4, d: 2.4 }
    ]);
  }

  spawnDetailedTree(tx, tz, radius, height, trunkMat, foliageMat, isBirch = false, hasCollider = true) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.7, radius, height, 9), trunkMat);
    trunk.position.set(tx, height * 0.5, tz);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    this.levelGroup.add(trunk);

    if (hasCollider) {
      const box = new THREE.Box3().setFromObject(trunk);
      this.colliders.push({ box, mesh: trunk });
    }

    if (isBirch) {
      // Пишна крона берези
      const c1 = new THREE.Mesh(new THREE.DodecahedronGeometry(2.3, 1), foliageMat);
      c1.position.set(tx, height + 0.8, tz);
      c1.castShadow = true;
      this.levelGroup.add(c1);

      const c2 = new THREE.Mesh(new THREE.DodecahedronGeometry(1.75, 1), foliageMat);
      c2.position.set(tx + 0.6, height + 2.2, tz - 0.4);
      c2.castShadow = true;
      this.levelGroup.add(c2);
    } else {
      // Багатоярусна крона високої сосни / смереки
      const f1 = new THREE.Mesh(new THREE.ConeGeometry(2.5, 4.2, 9), foliageMat);
      f1.position.set(tx, height + 0.4, tz);
      f1.castShadow = true;
      this.levelGroup.add(f1);

      const f2 = new THREE.Mesh(new THREE.ConeGeometry(2.0, 3.6, 9), foliageMat);
      f2.position.set(tx, height + 2.4, tz);
      f2.castShadow = true;
      this.levelGroup.add(f2);

      const f3 = new THREE.Mesh(new THREE.ConeGeometry(1.35, 2.8, 9), foliageMat);
      f3.position.set(tx, height + 4.2, tz);
      f3.castShadow = true;
      this.levelGroup.add(f3);
    }
  }

  /**
   * КАРТА 0: ДЕННИЙ ЛІС (DAY FOREST // СОНЯЧНИЙ СОСНОВО-БЕРЕЗОВИЙ ЛІС)
   */
  buildDayForestMap() {
    this.populateNaturalWoodland(false);

    // Яскравий сонячний диск високо в небі над верхівками сосен
    const sunDisk = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfffbe6 })
    );
    sunDisk.position.set(24, 42, -28);
    this.lightsGroup.add(sunDisk);
  }

  /**
   * КАРТА 1: НІЧНИЙ ЛІС (NIGHT FOREST // ТЕМНИЙ НІЧНИЙ ЛІС ІЗ ЗОРЯНИМ НЕБОМ, ПОВНИМ МІСЯЦЕМ І ВОГНИЩЕМ)
   */
  buildNightForestMap() {
    this.populateNaturalWoodland(true);

    // 1. Великий сяючий Повний Місяць у нічному небі над верхівками дерев
    const moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(3.6, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xdbeafe })
    );
    moonMesh.position.set(-18, 38, -32);
    this.lightsGroup.add(moonMesh);

    // 2. Зоряне нічне небо (260 зірок над лісом)
    const starPositions = new Float32Array(260 * 3);
    for (let i = 0; i < 260; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.42;
      const r = 62;
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = 16 + r * Math.cos(phi);
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xe2e8f0, size: 0.45 });
    const stars = new THREE.Points(starGeo, starMat);
    this.lightsGroup.add(stars);

    // 3. Два лісові вогнища на галявинах (дають живе полум'я і відблиски в нічному лісі)
    const campfires = [
      { x: -4.2, z: 4.5 },
      { x: 4.2, z: -4.5 }
    ];
    const emberMat = new THREE.MeshBasicMaterial({ color: 0xff6b1a });
    for (const cf of campfires) {
      const fireCone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.68, 7), emberMat);
      fireCone.position.set(cf.x, 0.34, cf.z);
      this.lightsGroup.add(fireCone);

      const fireLight = new THREE.PointLight(0xff6b22, 2.6, 13, 1.7);
      fireLight.position.set(cf.x, 0.75, cf.z);
      this.lightsGroup.add(fireLight);
    }
  }

  /**
   * КАРТА 1: СВІТЛИЙ ПРОМИСЛОВИЙ АНГАР З КОНТЕЙНЕРАМИ (SUNLIT WAREHOUSE)
   */
  buildSunlitWarehouseMap() {
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.textures.concreteBright,
      roughness: 0.45,
      metalness: 0.2
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 40), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.levelGroup.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({
      map: this.textures.whiteBrick,
      roughness: 0.7,
      metalness: 0.1
    });
    const yellowContainer = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.5, metalness: 0.35 });
    const blueContainer = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.5, metalness: 0.35 });
    const orangeContainer = new THREE.MeshStandardMaterial({ color: 0xea580c, roughness: 0.5, metalness: 0.35 });
    const crateMat = new THREE.MeshStandardMaterial({ map: this.textures.plywood, roughness: 0.75 });

    this.addPerimeterWalls(32, 36, 5.2, wallMat);

    // Світлі балки під скляним дахом ангара
    const beamMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.5, roughness: 0.4 });
    for (let z = -12; z <= 12; z += 8) {
      this.addColliderBox(0, 5.0, z, 32, 0.35, 0.45, beamMat, false);
    }

    // Морські контейнери на арені
    this.addColliderBox(-5.2, 1.4, 6.2, 2.6, 2.8, 6.2, blueContainer);
    this.addColliderBox(5.2, 1.4, 5.5, 2.6, 2.8, 5.5, yellowContainer);

    this.addColliderBox(0.0, 1.4, 0.0, 5.8, 2.8, 2.5, orangeContainer);

    this.addColliderBox(-5.2, 1.4, -6.2, 2.6, 2.8, 6.2, yellowContainer);
    this.addColliderBox(5.2, 1.4, -6.0, 2.6, 2.8, 5.8, blueContainer);

    // Ящики та палети для пікінгу [Q/E]
    const crates = [
      [0, 8.8], [-2.5, 3.2], [2.5, 3.2],
      [-2.5, -3.4], [2.5, -3.4], [0, -8.8],
      [-9.5, 0], [9.5, 0]
    ];
    for (const [cx, cz] of crates) {
      this.addColliderBox(cx, 0.65, cz, 1.5, 1.3, 1.5, crateMat);
    }

    this.addReflectivePuddles([
      { x: 0, z: 4.8, w: 4.4, d: 3.0 },
      { x: 0, z: -4.8, w: 4.4, d: 3.0 }
    ]);
  }

  /**
   * КАРТА 2: СОНЯЧНИЙ ДАХ ХМАРОЧОСА З ГЕЛІКОПТЕРНИМ МАЙДАНЧИКОМ (ROOFTOP HELIPAD)
   */
  buildRooftopHelipadMap() {
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.textures.concreteBright,
      roughness: 0.55,
      metalness: 0.15
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 40), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.levelGroup.add(floor);

    // Жовта розмітка гелікоптерного майданчика [H] по центру даху
    const markMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.8, 5.2, 32), markMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    this.levelGroup.add(ring);

    const hLeft = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 3.6), markMat);
    hLeft.rotation.x = -Math.PI / 2;
    hLeft.position.set(-1.2, 0.015, 0);
    this.levelGroup.add(hLeft);

    const hRight = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 3.6), markMat);
    hRight.rotation.x = -Math.PI / 2;
    hRight.position.set(1.2, 0.015, 0);
    this.levelGroup.add(hRight);

    const hMid = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.55), markMat);
    hMid.rotation.x = -Math.PI / 2;
    hMid.position.set(0, 0.015, 0);
    this.levelGroup.add(hMid);

    const parapetMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.65 });
    const hvacMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.65 });
    const glassWallMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.15, metalness: 0.8 });
    const sandbagMat = new THREE.MeshStandardMaterial({ map: this.textures.sandTex, roughness: 0.85 });

    this.addPerimeterWalls(32, 36, 2.2, parapetMat);

    // Вентиляційні блоки HVAC та скляні надбудови ліфтових шахт
    this.addColliderBox(-5.8, 1.35, 6.5, 4.2, 2.7, 3.2, hvacMat);
    this.addColliderBox(5.8, 1.35, 6.5, 4.2, 2.7, 3.2, glassWallMat);

    this.addColliderBox(-6.5, 1.25, 0.0, 2.4, 2.5, 4.5, hvacMat);
    this.addColliderBox(6.5, 1.25, 0.0, 2.4, 2.5, 4.5, hvacMat);

    this.addColliderBox(-5.8, 1.35, -6.5, 4.2, 2.7, 3.2, glassWallMat);
    this.addColliderBox(5.8, 1.35, -6.5, 4.2, 2.7, 3.2, hvacMat);

    // Тактичні барикади навколо гелікоптерного кола
    this.addColliderBox(0, 0.65, 4.2, 3.6, 1.3, 0.9, sandbagMat);
    this.addColliderBox(0, 0.65, -4.2, 3.6, 1.3, 0.9, sandbagMat);
    this.addColliderBox(-2.8, 0.65, 9.8, 2.2, 1.3, 1.0, sandbagMat);
    this.addColliderBox(2.8, 0.65, -9.8, 2.2, 1.3, 1.0, sandbagMat);

    this.addReflectivePuddles([
      { x: 0, z: 0, w: 5.2, d: 5.2 }
    ]);
  }

  /**
   * КАРТА 3: ПУСТЕЛЬНА БАЗА ПІД СОНЦЕМ (DESERT COMPOUND)
   */
  buildDesertCompoundMap() {
    const floorMat = new THREE.MeshStandardMaterial({
      map: this.textures.sandTex,
      roughness: 0.88,
      metalness: 0.04
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 40), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.levelGroup.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({
      map: this.textures.sandstoneWall,
      roughness: 0.82,
      metalness: 0.05
    });
    const crateMat = new THREE.MeshStandardMaterial({ map: this.textures.plywood, roughness: 0.78 });
    const tarpMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.7 });

    this.addPerimeterWalls(32, 36, 3.6, wallMat);

    // Пісковикові будівлі та арки в центрі бази
    this.addColliderBox(-5.2, 1.6, 6.8, 6.0, 3.2, 0.55, wallMat);
    this.addColliderBox(5.2, 1.6, 6.8, 6.0, 3.2, 0.55, wallMat);

    this.addColliderBox(-3.5, 1.6, 0.0, 0.6, 3.2, 7.5, wallMat);
    this.addColliderBox(3.5, 1.6, 0.0, 0.6, 3.2, 7.5, wallMat);
    this.addColliderBox(0.0, 2.8, 0.0, 7.6, 0.8, 3.5, tarpMat, false); // Тент над центральним проходом

    this.addColliderBox(-5.2, 1.6, -6.8, 6.0, 3.2, 0.55, wallMat);
    this.addColliderBox(5.2, 1.6, -6.8, 6.0, 3.2, 0.55, wallMat);

    // Бетонні блоки та ящики з боєприпасами
    const blocks = [
      [0, 10.2], [0, 3.5], [0, -3.5], [0, -10.2],
      [-8.5, 2.5], [8.5, -2.5], [-8.5, -2.5], [8.5, 2.5]
    ];
    for (const [bx, bz] of blocks) {
      this.addColliderBox(bx, 0.65, bz, 2.1, 1.3, 1.1, crateMat);
    }
  }

  /**
   * Проекція об'ємної декалі колоїдної крові (DBuffer Decal із поверхневим натягом, SSS та висиханням за 10–30 с)
   */
  spawnColloidalBloodDecal(point, normal, radius = 0.42, stretchX = 1.0, stretchY = 1.0) {
    const geo = new THREE.PlaneGeometry(radius * 2 * stretchX, radius * 2 * stretchY);
    const mat = this.shaderFactory.createColloidalBloodDecalMaterial(Math.random() * 100.0);
    const decal = new THREE.Mesh(geo, mat);

    decal.position.copy(point).addScaledVector(normal, 0.008 + Math.random() * 0.004);
    decal.lookAt(point.clone().add(normal));
    decal.rotateZ(Math.random() * Math.PI * 2);

    this.scene.add(decal);
    this.bloodDecals.push({ mesh: decal, mat, age: 0.0 });

    if (this.bloodDecals.length > 65) {
      const oldest = this.bloodDecals.shift();
      this.scene.remove(oldest.mesh);
    }
  }

  /**
   * Гідродинамічний удар кулі (700–900 м/с):
   * - Кривавий туман (Blood Mist), що зависає в повітрі на пів секунди й розсіюється
   * - Важкі краплі (Droplets), що летять по балістичній дузі й при падінні залишають витягнуті сліди бризок
   * - Проекція декалей крові на стіни/укриття позаду ворога
   */
  spawnBulletImpact(point, normal, isFlesh = false, bulletDir = null) {
    if (!isFlesh) {
      const decalGeo = new THREE.CircleGeometry(0.045, 8);
      const decalMat = new THREE.MeshBasicMaterial({
        color: 0x1a1c1e,
        polygonOffset: true,
        polygonOffsetFactor: -1
      });
      const decal = new THREE.Mesh(decalGeo, decalMat);
      decal.position.copy(point).addScaledVector(normal, 0.006);
      decal.lookAt(point.clone().add(normal));
      this.scene.add(decal);
      this.impactDecals.push(decal);
      if (this.impactDecals.length > 70) {
        const old = this.impactDecals.shift();
        this.scene.remove(old);
      }

      // Іскри та бетонний пил
      for (let i = 0; i < 12; i++) {
        const size = i < 4 ? 0.022 : 0.045;
        const color = i < 4 ? 0xffcf56 : 0x9ca3af;
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
        mesh.position.copy(point);

        const vel = normal.clone().multiplyScalar(1.5 + Math.random() * 3.5);
        vel.x += (Math.random() - 0.5) * 3.2;
        vel.y += Math.random() * 2.6;
        vel.z += (Math.random() - 0.5) * 3.2;

        this.scene.add(mesh);
        this.particles.push({
          mesh,
          vel,
          life: 0.35 + Math.random() * 0.35,
          maxLife: 0.7,
          gravity: i < 4 ? 9.8 : 4.2,
          isMist: false,
          isDroplet: false
        });
      }
      return;
    }

    // === 1. КРИВАВИЙ ТУМАН (Blood Mist — Niagara Aerosol) ===
    // Мікроскопічна хмара дрібного рубіново-червоного пилу, що зависає в повітрі на 0.6–0.9 с
    for (let m = 0; m < 6; m++) {
      const mistMat = new THREE.MeshBasicMaterial({
        color: m % 2 === 0 ? 0xa80b16 : 0x520408,
        transparent: true,
        opacity: 0.52,
        depthWrite: false
      });
      const mistMesh = new THREE.Mesh(new THREE.SphereGeometry(0.13 + Math.random() * 0.09, 8, 8), mistMat);
      mistMesh.position.copy(point).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.22,
        (Math.random() - 0.5) * 0.22,
        (Math.random() - 0.5) * 0.22
      ));

      const mistVel = normal.clone().multiplyScalar(0.35 + Math.random() * 0.65);
      mistVel.x += (Math.random() - 0.5) * 0.9;
      mistVel.y += 0.15 + Math.random() * 0.45;
      mistVel.z += (Math.random() - 0.5) * 0.9;

      this.scene.add(mistMesh);
      this.particles.push({
        mesh: mistMesh,
        vel: mistVel,
        life: 0.65 + Math.random() * 0.25,
        maxLife: 0.9,
        gravity: 0.28, // Майже невагомий аерозоль у повітрі
        isMist: true,
        isDroplet: false
      });
    }

    // === 2. ВАЖКІ БАЛІСТИЧНІ КРАПЛІ КРОВІ (Heavy Droplets) ===
    // Летять по чесній балістичній дузі під дією гравітації і залишають витягнуті сліди на землі
    const sprayDir = bulletDir ? bulletDir.clone().normalize() : normal.clone();
    for (let d = 0; d < 16; d++) {
      const dropSize = 0.022 + Math.random() * 0.026;
      const dropMat = new THREE.MeshBasicMaterial({
        color: d % 3 === 0 ? 0xc40e1c : 0x2b0205, // Рубіновий SSS на просвіт vs темна венозна кров
        transparent: true,
        opacity: 0.95
      });
      const dropMesh = new THREE.Mesh(new THREE.BoxGeometry(dropSize * 0.7, dropSize * 0.7, dropSize * 2.2), dropMat);
      dropMesh.position.copy(point);

      const vel = sprayDir.clone().multiplyScalar(2.2 + Math.random() * 4.8);
      vel.x += (Math.random() - 0.5) * 3.4;
      vel.y += 0.8 + Math.random() * 2.6;
      vel.z += (Math.random() - 0.5) * 3.4;

      this.scene.add(dropMesh);
      this.particles.push({
        mesh: dropMesh,
        vel,
        life: 1.1,
        maxLife: 1.1,
        gravity: 9.8,
        isMist: false,
        isDroplet: true,
        spawnedDecal: false
      });
    }

    // === 3. DBUFFER ДЕКАЛЬ НА СТІНІ ПОЗАДУ ЦІЛІ ТА КАЛЮЖА ПІД НОГАМИ ===
    this.spawnColloidalBloodDecal(
      new THREE.Vector3(point.x, 0.005, point.z),
      new THREE.Vector3(0, 1, 0),
      0.36 + Math.random() * 0.25,
      1.25,
      0.95
    );

    if (bulletDir) {
      const wallRay = new THREE.Raycaster(point, bulletDir.clone().normalize(), 0.1, 4.5);
      const hits = wallRay.intersectObjects(this.colliders.map((c) => c.mesh), false);
      if (hits.length > 0 && hits[0].face) {
        const wNormal = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
        this.spawnColloidalBloodDecal(hits[0].point, wNormal, 0.44 + Math.random() * 0.24, 1.0, 1.35);
      }
    }
  }

  spawnShellCasing(origin, rightVec, upVec) {
    const geo = new THREE.CylinderGeometry(0.007, 0.007, 0.036, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.25,
      metalness: 0.88
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin);

    const vel = rightVec.clone().multiplyScalar(2.2 + Math.random() * 1.1)
      .addScaledVector(upVec, 1.4 + Math.random() * 0.8);

    this.scene.add(mesh);
    this.shellCasings.push({
      mesh,
      vel,
      rotVel: new THREE.Vector3(Math.random() * 22, Math.random() * 22, Math.random() * 22),
      life: 4.5
    });

    if (this.shellCasings.length > 35) {
      const oldest = this.shellCasings.shift();
      this.scene.remove(oldest.mesh);
    }
  }

  isPointInPuddle(x, z) {
    for (const p of this.puddleZones) {
      const dx = (x - p.x) / (p.w * 0.5);
      const dz = (z - p.z) / (p.d * 0.5);
      if (dx * dx + dz * dz <= 1.0) return true;
    }
    return false;
  }

  update(dt, lightSourcePos = null) {
    // 1. Оновлення шейдера висихання та згортання крові (Drying & Coagulation за 10–30 секунд)
    for (const bd of this.bloodDecals) {
      bd.age += dt;
      bd.mat.uniforms.uAge.value = bd.age;
      if (lightSourcePos) {
        bd.mat.uniforms.uLightPos.value.copy(lightSourcePos);
      }
    }

    // 2. Оновлення кривавого туману (Blood Mist) та балістичних крапель (Heavy Droplets)
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      if (p.isMist) {
        // Кривавий туман плавно розширюється в повітрі та розсіюється
        p.mesh.scale.multiplyScalar(1.0 + dt * 2.1);
        p.vel.multiplyScalar(1.0 - dt * 2.5);
        p.mesh.material.opacity = Math.max(0, (p.life / p.maxLife) * 0.52);
      } else if (p.isDroplet) {
        // Орієнтація важкої краплі вздовж балістичної дуги польоту
        p.mesh.lookAt(p.mesh.position.clone().add(p.vel));
        if (p.mesh.position.y <= 0.015 && !p.spawnedDecal) {
          p.spawnedDecal = true;
          p.life = 0; // Крапля вдаряється об землю та перетворюється на витягнутий слід бризок!
          if (Math.random() < 0.45) {
            this.spawnColloidalBloodDecal(
              new THREE.Vector3(p.mesh.position.x, 0.005, p.mesh.position.z),
              new THREE.Vector3(0, 1, 0),
              0.14 + Math.random() * 0.16,
              1.45,
              0.75
            );
          }
        }
      } else {
        p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
      }
    }

    for (let i = this.shellCasings.length - 1; i >= 0; i--) {
      const c = this.shellCasings[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        this.shellCasings.splice(i, 1);
        continue;
      }
      if (c.mesh.position.y > 0.015) {
        c.vel.y -= 9.8 * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.mesh.rotation.x += c.rotVel.x * dt;
        c.mesh.rotation.y += c.rotVel.y * dt;
        c.mesh.rotation.z += c.rotVel.z * dt;
        if (c.mesh.position.y <= 0.015) {
          c.mesh.position.y = 0.015;
          c.vel.y = Math.abs(c.vel.y) * 0.32;
          c.vel.x *= 0.5;
          c.vel.z *= 0.5;
        }
      }
    }
  }
}
