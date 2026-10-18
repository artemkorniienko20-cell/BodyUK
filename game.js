import * as THREE from 'three';
import { BodycamPostProcessor } from './shaders.js';
import { BodycamAudioEngine } from './audio.js';
import { TacticalEnvironment } from './environment.js';

class BodycamSimulator {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(96, window.innerWidth / window.innerHeight, 0.05, 110);

    this.postProcessor = new BodycamPostProcessor(this.renderer);
    this.audio = new BodycamAudioEngine();
    this.env = new TacticalEnvironment(this.scene);

    // Ігровий режим: 'tdm' (Командний бій 5v5) або 'dm' (Deathmatch із заміною карти кожні 60 с)
    this.gameMode = 'tdm';
    this.mapRotationDuration = 60.0; // 1 хвилина (60 секунд)
    this.mapRotationTimer = this.mapRotationDuration;

    // Рахунок команд та гравця
    this.swatScore = 0;
    this.opforScore = 0;
    this.playerKills = 0;
    this.playerDeaths = 0;

    // Стан гри та оператора
    this.isRunning = false;
    this.isDead = false;
    this.respawnTimer = 0;
    this.opticsMenuOpen = false;

    // Окуляри нічного бачення AN/PVS-31 (Клавіша [N])
    this.nvgActive = false;
    this.nvgWarmup = 0.0;

    // Позиція бійця: камера на рівні грудей (y = 1.32м)
    this.chestHeight = 1.32;
    this.playerPos = new THREE.Vector3(0, this.chestHeight, 13.5);
    this.playerRadius = 0.42;

    // Орієнтація корпусу vs Вільне прицілювання рук зі зброєю (Free-Aim)
    this.bodyYaw = 0;
    this.bodyPitch = 0;
    this.weaponAimYaw = 0;
    this.weaponAimPitch = 0;
    this.freeAimScale = 1.0;

    // Пружинна інерція рук та віддача
    this.weaponLagYaw = 0;
    this.weaponLagPitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilKickBack = 0;
    this.cameraShake = new THREE.Vector3();

    // Нахили корпусу за ріг [Q / E]
    this.leanTarget = 0;
    this.leanCurrent = 0;

    // Боєкомплект
    this.magCapacity = 30;
    this.currentAmmo = 30;
    this.reserveMags = 5;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.isCheckingAmmo = false;
    this.checkAmmoTimer = 0;
    this.isAiming = false;
    this.flashlightOn = true;
    this.grenadesLeft = 3;

    // Здоров'я та ефекти сенсора
    this.playerHealth = 100;
    this.damagePulse = 0;
    this.concussionAmount = 0;
    this.deathFallProgress = 0;

    this.adaptedLuma = 0.42;
    this.overexposureFlash = 0.0;
    this.userExposureMultiplier = 1.15;

    this.keys = {};
    this.mouseDelta = new THREE.Vector2();
    this.walkCycle = 0;
    this.stepAccum = 0;

    // Режим керування: 'pc' (Клавіатура WASD + Миша), 'joystick' (Стіки + Геймпад) або 'phone' (Кнопки для телефона + Авто 60 Гц)
    this.inputMode = 'pc';
    this.lock60Hz = false;
    this.targetFrameIntervalMs = 1000 / 60; // 16.6667 мс = 60 Гц
    this.lastRenderTimeMs = 0;
    this.fpsCounterFrames = 0;
    this.fpsCounterAccum = 0;
    this.measuredHz = 60;
    this.joyLeftVec = new THREE.Vector2(0, 0);
    this.joyRightVec = new THREE.Vector2(0, 0);
    this.phoneLookVec = new THREE.Vector2(0, 0);
    this.phoneSprintActive = false;
    this.joyFiring = false;
    this.joyFireTimer = 0;
    this.prevGamepadButtons = {};

    // Бійці на карті (союзники SWAT та вороги OPFOR) і гранати
    this.bots = [];
    this.activeGrenades = [];
    this.raycaster = new THREE.Raycaster();

    this.buildChestRigAndWeapon();
    this.spawnBotsForMode();
    this.updateOSDLabels();
    this.bindEvents();
    this.bindUI();
    this.bindJoystickControls();
    this.bindPhoneControls();

    this.clock = new THREE.Clock();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  /**
   * 3D-модель рук та карабіна M4A1 SOPMOD із інфрачервоним лазером AN/PEQ-15 (видимим у ПНБ [N])
   */
  buildChestRigAndWeapon() {
    this.cameraRig = new THREE.Group();
    this.scene.add(this.cameraRig);
    this.cameraRig.add(this.camera);

    this.weaponPivot = new THREE.Group();
    this.camera.add(this.weaponPivot);

    this.weaponMeshGroup = new THREE.Group();
    this.weaponPivot.add(this.weaponMeshGroup);

    const gunMetal = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.38, metalness: 0.82 });
    const fdePolymer = new THREE.MeshStandardMaterial({ color: 0x6b5d47, roughness: 0.65, metalness: 0.15 });
    // 2. Шейдер тактичної тканини Cordura / камуфляжу з ефектом мікроворсинок (Cloth Fuzz / Sheen)
    const sleeveFabric = this.env.shaderFactory.createTacticalClothMaterial({
      baseColor: 0x272d28,
      sheenColor: 0x627064,
      roughness: 0.88
    });
    const gloveLeather = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.72, metalness: 0.1 });
    // 1 & 3. Шейдер людської шкіри: Subsurface Profile (SSS) + карта мікропор + динамічний шар поту (Sweat Layer)
    const operatorSkinMat = this.env.shaderFactory.createSubsurfaceSkinMaterial();

    // Ствольна коробка та цівка
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.095, 0.28), gunMetal);
    receiver.position.set(0, 0, -0.18);
    this.weaponMeshGroup.add(receiver);

    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.064, 0.30), fdePolymer);
    handguard.position.set(0, 0.012, -0.45);
    this.weaponMeshGroup.add(handguard);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 12), gunMetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.64);
    this.weaponMeshGroup.add(barrel);

    const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.16, 16), fdePolymer);
    suppressor.rotation.x = Math.PI / 2;
    suppressor.position.set(0, 0.012, -0.76);
    this.weaponMeshGroup.add(suppressor);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.11, 0.19), fdePolymer);
    stock.position.set(0, -0.01, 0.04);
    this.weaponMeshGroup.add(stock);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.11, 0.055), fdePolymer);
    grip.position.set(0, -0.085, -0.09);
    grip.rotation.x = 0.28;
    this.weaponMeshGroup.add(grip);

    // Коліматор EOTech EXPS3
    const sightBody = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.058, 0.085), fdePolymer);
    sightBody.position.set(0, 0.072, -0.20);
    this.weaponMeshGroup.add(sightBody);

    // Блок AN/PEQ-15 + ІЧ-лазерний промінь для окулярів нічного бачення [N]
    const peqBox = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.032, 0.095), fdePolymer);
    peqBox.position.set(0, 0.056, -0.52);
    this.weaponMeshGroup.add(peqBox);

    const irBeamGeo = new THREE.CylinderGeometry(0.0018, 0.0018, 22, 6);
    irBeamGeo.rotateX(Math.PI / 2);
    irBeamGeo.translate(0, 0, -11.0);
    this.irLaserBeam = new THREE.Mesh(
      irBeamGeo,
      new THREE.MeshBasicMaterial({
        color: 0x38ff6a,
        transparent: true,
        opacity: 0.48,
        blending: THREE.AdditiveBlending
      })
    );
    this.irLaserBeam.position.set(0.012, 0.058, -0.56);
    this.irLaserBeam.visible = false;
    this.weaponMeshGroup.add(this.irLaserBeam);

    // Прицільна марка EOTech
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0xff2a2a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88
    });
    const reticleRing = new THREE.Mesh(new THREE.RingGeometry(0.007, 0.009, 16), reticleMat);
    reticleRing.position.set(0, 0.074, -0.156);
    this.weaponMeshGroup.add(reticleRing);

    const reticleDot = new THREE.Mesh(new THREE.CircleGeometry(0.0022, 8), reticleMat);
    reticleDot.position.set(0, 0.074, -0.155);
    this.weaponMeshGroup.add(reticleDot);

    // Затворна рама
    const boltMat = new THREE.MeshStandardMaterial({ color: 0x8b929a, roughness: 0.25, metalness: 0.9 });
    this.boltCarrier = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.024, 0.075), boltMat);
    this.boltCarrier.position.set(0.026, 0.022, -0.18);
    this.weaponMeshGroup.add(this.boltCarrier);

    // Прозорий магазин PMAG для візуальної перевірки набоїв [T]
    this.magGroup = new THREE.Group();
    this.magGroup.position.set(0, -0.115, -0.23);
    this.magGroup.rotation.x = -0.14;
    this.weaponMeshGroup.add(this.magGroup);

    const magShell = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.165, 0.068),
      new THREE.MeshStandardMaterial({
        color: 0x232528,
        roughness: 0.5,
        metalness: 0.2,
        transparent: true,
        opacity: 0.72
      })
    );
    this.magGroup.add(magShell);

    this.magBulletMeshes = [];
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xf5c542,
      roughness: 0.22,
      metalness: 0.92,
      emissive: 0x3a2a05
    });
    for (let i = 0; i < 10; i++) {
      const bMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.048, 8), brassMat);
      bMesh.rotation.x = Math.PI / 2;
      bMesh.position.set(0, 0.06 - i * 0.013, 0);
      this.magGroup.add(bMesh);
      this.magBulletMeshes.push(bMesh);
    }

    // Руки бійця (тактичні рукави Cordura з мікроворсом + безпалі рукавиці з відкритими пальцями та зап'ястями SSS)
    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.088, 0.38), sleeveFabric);
    leftArm.position.set(-0.12, -0.065, -0.26);
    leftArm.rotation.y = -0.26;
    leftArm.rotation.x = 0.16;
    this.weaponMeshGroup.add(leftArm);

    const leftWristSkin = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.068, 0.045), operatorSkinMat);
    leftWristSkin.position.set(-0.042, -0.018, -0.39);
    this.weaponMeshGroup.add(leftWristSkin);

    const leftGlove = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.075, 0.075), gloveLeather);
    leftGlove.position.set(-0.025, -0.01, -0.435);
    this.weaponMeshGroup.add(leftGlove);

    // Відкриті фаланги пальців лівої руки (просвічуються червоним SSS від дульного спалаху та сонця)
    const leftFingersSkin = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.058, 0.042), operatorSkinMat);
    leftFingersSkin.position.set(-0.018, 0.002, -0.482);
    this.weaponMeshGroup.add(leftFingersSkin);

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.092, 0.34), sleeveFabric);
    rightArm.position.set(0.10, -0.10, 0.02);
    rightArm.rotation.y = 0.15;
    rightArm.rotation.x = 0.22;
    this.weaponMeshGroup.add(rightArm);

    const rightGlove = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.072, 0.075), gloveLeather);
    rightGlove.position.set(0.01, -0.065, -0.085);
    this.weaponMeshGroup.add(rightGlove);

    // Вказівний палець на спусковому гачку зі шкірою Subsurface Profile
    const triggerFingerSkin = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.024, 0.048), operatorSkinMat);
    triggerFingerSkin.position.set(0.018, -0.042, -0.13);
    this.weaponMeshGroup.add(triggerFingerSkin);

    // Дульний спалах
    const flashGeo = new THREE.ConeGeometry(0.065, 0.22, 7);
    flashGeo.rotateX(-Math.PI / 2);
    this.muzzleFlashMesh = new THREE.Mesh(
      flashGeo,
      new THREE.MeshBasicMaterial({ color: 0xffd97d, transparent: true, opacity: 0.0 })
    );
    this.muzzleFlashMesh.position.set(0, 0.012, -0.90);
    this.weaponMeshGroup.add(this.muzzleFlashMesh);

    this.muzzleLight = new THREE.PointLight(0xffb84d, 0, 14, 1.6);
    this.muzzleLight.position.set(0, 0.012, -0.92);
    this.weaponMeshGroup.add(this.muzzleLight);

    // Надпотужний тактичний ліхтарик SureFire M640DF (1500 люмен: центральний прожектор + широке бокове засвічення)
    this.flashlightMaxIntensity = 42.0;
    this.flashlightSpillIntensity = 14.0;

    // 3D-корпус підствольного ліхтаря та яскрава лінза
    const lightBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.011, 0.11, 12),
      gunMetal
    );
    lightBody.rotation.x = Math.PI / 2;
    lightBody.position.set(0.036, 0.015, -0.54);
    this.weaponMeshGroup.add(lightBody);

    this.flashlightLensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const lightLens = new THREE.Mesh(new THREE.CircleGeometry(0.011, 12), this.flashlightLensMat);
    lightLens.position.set(0.036, 0.015, -0.596);
    lightLens.rotation.y = Math.PI;
    this.weaponMeshGroup.add(lightLens);

    // Візуальний об'ємний конус світла в тумані/пилу
    const beamConeGeo = new THREE.ConeGeometry(0.75, 9.5, 20, 1, true);
    beamConeGeo.rotateX(Math.PI / 2);
    beamConeGeo.translate(0, 0, -4.75);
    this.flashlightBeamCone = new THREE.Mesh(
      beamConeGeo,
      new THREE.MeshBasicMaterial({
        color: 0xe8f4ff,
        transparent: true,
        opacity: 0.055,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    this.flashlightBeamCone.position.set(0.036, 0.015, -0.60);
    this.weaponMeshGroup.add(this.flashlightBeamCone);

    // 1. Центральний далекобійний промінь (Hotspot — пробиває темряву на 70 метрів)
    this.flashlight = new THREE.SpotLight(
      0xf4f9ff,
      this.flashlightMaxIntensity,
      70,
      Math.PI / 4.4,
      0.38,
      0.88
    );
    this.flashlight.position.set(0.036, 0.015, -0.60);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.width = 1024;
    this.flashlight.shadow.mapSize.height = 1024;
    this.flashlight.shadow.camera.near = 0.25;
    this.flashlight.shadow.camera.far = 65;
    this.flashlight.shadow.bias = -0.0005;

    // 2. Широке периферійне засвічення (Spill — освітлює простір навколо бійця)
    this.flashlightSpill = new THREE.SpotLight(
      0xdcebff,
      this.flashlightSpillIntensity,
      34,
      Math.PI / 2.2,
      0.78,
      1.05
    );
    this.flashlightSpill.position.set(0.036, 0.015, -0.60);

    this.flashlightTarget = new THREE.Object3D();
    this.flashlightTarget.position.set(0.036, 0.015, -12.0);
    this.weaponMeshGroup.add(this.flashlight);
    this.weaponMeshGroup.add(this.flashlightSpill);
    this.weaponMeshGroup.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;
    this.flashlightSpill.target = this.flashlightTarget;
  }

  /**
   * Створення бійців залежно від обраного режиму:
   * - 'tdm' (Командний бій 5v5): 4 союзники SWAT (синій шолом + жовті пов'язки + зелений ІЧ-маячок) + гравець проти 5 бійців OPFOR
   * - 'dm' (Deathmatch): 8 супротивників у режимі «кожен сам за себе» з миттєвим респавном
   */
  spawnBotsForMode() {
    for (const b of this.bots) {
      this.scene.remove(b.group);
    }
    this.bots = [];

    if (this.gameMode === 'tdm') {
      // 4 Союзники SWAT (стартують на південній стороні разом із гравцем)
      const swatSpawns = [
        { x: -4.2, z: 12.5, patrolX: -2.2 },
        { x: 4.2, z: 12.5, patrolX: 2.2 },
        { x: -7.5, z: 8.5, patrolX: -5.2 },
        { x: 7.5, z: 8.5, patrolX: 5.2 }
      ];
      for (const sp of swatSpawns) {
        this.createBot('swat', sp.x, sp.z, sp.patrolX);
      }

      // 5 Ворогів OPFOR (стартують на північній стороні та в центрі)
      const opforSpawns = [
        { x: -4.5, z: -12.5, patrolX: -1.8 },
        { x: 4.5, z: -12.5, patrolX: 1.8 },
        { x: 0.0, z: -9.5, patrolX: 2.5 },
        { x: -7.8, z: -5.5, patrolX: -4.8 },
        { x: 7.8, z: -5.5, patrolX: 4.8 }
      ];
      for (const sp of opforSpawns) {
        this.createBot('opfor', sp.x, sp.z, sp.patrolX);
      }
    } else {
      // Deathmatch (FFA): 8 бійців по всьому периметру карти
      const dmSpawns = [
        { x: -7.5, z: 11.5, patrolX: -4.2 },
        { x: 7.5, z: 11.5, patrolX: 4.2 },
        { x: -8.2, z: 2.5, patrolX: -5.0 },
        { x: 8.2, z: -2.5, patrolX: 5.0 },
        { x: -4.5, z: -12.5, patrolX: -1.5 },
        { x: 4.5, z: -12.5, patrolX: 1.5 },
        { x: 0.0, z: -8.5, patrolX: 2.8 },
        { x: -2.5, z: 5.5, patrolX: 2.5 }
      ];
      for (const sp of dmSpawns) {
        this.createBot('opfor', sp.x, sp.z, sp.patrolX);
      }
    }
  }

  createBot(team, x, z, patrolX) {
    const isAlly = team === 'swat';
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // 2. Шейдер тактичної тканини Cordura та камуфляжу (Cloth Shading Model із контурним мікроворсом Fuzz/Sheen)
    const legsMat = this.env.shaderFactory.createTacticalClothMaterial({
      baseColor: isAlly ? 0x243447 : 0x2b2927,
      sheenColor: isAlly ? 0x56718f : 0x666057,
      roughness: 0.88
    });
    const torsoMat = this.env.shaderFactory.createTacticalClothMaterial({
      baseColor: isAlly ? 0x1d3557 : 0x3b1d1d,
      sheenColor: isAlly ? 0x4b6b94 : 0x734949,
      roughness: 0.84
    });
    // 1 & 3. Шейдер живої шкіри: Subsurface Profile (SSS) + карта мікропор + шар поту (Sweat / Wetness Layer)
    const skinMat = this.env.shaderFactory.createSubsurfaceSkinMaterial();

    const helmetMat = new THREE.MeshStandardMaterial({
      color: isAlly ? 0x2563eb : 0x18181b,
      roughness: 0.55
    });
    const armbandMat = new THREE.MeshBasicMaterial({
      color: isAlly ? 0xfacc15 : 0xef4444 // Жовтий маркер у союзників SWAT, червоний у OPFOR
    });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x111315, roughness: 0.4, metalness: 0.8 });

    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.78, 0.26), legsMat);
    legs.position.y = 0.39;
    legs.castShadow = true;
    group.add(legs);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.64, 0.30), torsoMat);
    torso.position.y = 1.10;
    torso.castShadow = true;
    group.add(torso);

    // Тактична ідентифікаційна смуга на грудях/плечах (щоб у бою миттєво відрізняти союзників SWAT)
    const armband = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.32), armbandMat);
    armband.position.y = 1.26;
    group.add(armband);

    // Голова в шоломі/балаклаві з відкритим вирізом обличчя, переніссям та вухами (Subsurface Profile SSS + Sweat)
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.27, 0.25), helmetMat);
    head.position.y = 1.58;
    head.castShadow = true;
    head.userData.isHead = true;
    group.add(head);

    const faceSkinBand = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.095, 0.256), skinMat);
    faceSkinBand.position.set(0, 1.575, 0.004);
    group.add(faceSkinBand);

    // Крила носа та вуха (де найяскравіше видно червонувате підповерхневе розсіювання світла SSS)
    const noseBridge = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.052, 0.045), skinMat);
    noseBridge.position.set(0, 1.565, 0.138);
    group.add(noseBridge);

    const leftEar = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.062, 0.042), skinMat);
    leftEar.position.set(-0.132, 1.57, 0.0);
    group.add(leftEar);

    const rightEar = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.062, 0.042), skinMat);
    rightEar.position.set(0.132, 1.57, 0.0);
    group.add(rightEar);

    // 4. Очі з реакцією на стрес, адреналін і світло (динамічні зіниці, вени склери, заломлююча рогівка та слізне озерце)
    const eyePair = this.env.shaderFactory.createRealisticEyePair();
    eyePair.position.set(0, 1.585, 0.128);
    group.add(eyePair);

    // 5. Шейдер волосся, брів та вій за моделлю Маршнера (Marschner Hair Model: шляхи R, TT, TRT)
    const hairMat = this.env.shaderFactory.createMarschnerHairMaterial(isAlly ? 0x2c1d11 : 0x1c140e);
    const leftBrow = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.012, 0.016), hairMat);
    leftBrow.position.set(-0.056, 1.616, 0.134);
    leftBrow.rotation.z = -0.08;
    group.add(leftBrow);

    const rightBrow = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.012, 0.016), hairMat);
    rightBrow.position.set(0.056, 1.616, 0.134);
    rightBrow.rotation.z = 0.08;
    group.add(rightBrow);

    // Вії над очима та короткі пасма волосся на скронях (просвічуються золотом/міддю в контровому світлі TT)
    const leftEyelash = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.005, 0.014), hairMat);
    leftEyelash.position.set(-0.056, 1.601, 0.136);
    group.add(leftEyelash);

    const rightEyelash = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.005, 0.014), hairMat);
    rightEyelash.position.set(0.056, 1.601, 0.136);
    group.add(rightEyelash);

    const hairFringe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.022, 0.032), hairMat);
    hairFringe.position.set(0, 1.628, 0.126);
    group.add(hairFringe);

    // 6. Шейдер балістичних окулярів / забрала шолома (Thin Translucent полікарбонат із подвійним відбиттям, пилом і подряпинами)
    const visorMat = this.env.shaderFactory.createBallisticVisorMaterial({
      tintColor: isAlly ? 0xffe066 : 0x22262c
    });
    const ballisticGoggles = new THREE.Mesh(new THREE.BoxGeometry(0.246, 0.082, 0.026), visorMat);
    ballisticGoggles.position.set(0, 1.585, 0.144);
    group.add(ballisticGoggles);

    // Над шоломом союзників SWAT світиться тактичний маячок (IFF Strobe)
    if (isAlly) {
      const iffBeacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.065, 0),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
      );
      iffBeacon.position.y = 1.84;
      group.add(iffBeacon);
    }

    const arms = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.16, 0.38), legsMat);
    arms.position.set(0, 1.22, 0.16);
    group.add(arms);

    // Кисті рук бійця зі шкірою Subsurface Profile
    const handsSkin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.14), skinMat);
    handsSkin.position.set(0.14, 1.20, 0.34);
    group.add(handsSkin);

    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.62), gunMat);
    weapon.position.set(0.14, 1.22, 0.36);
    group.add(weapon);

    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffc44d, transparent: true, opacity: 0 })
    );
    flash.position.set(0.14, 1.22, 0.72);
    group.add(flash);

    this.scene.add(group);

    this.bots.push({
      team,
      isAlly,
      group,
      head,
      torso,
      legs,
      flash,
      eyePair,
      leftBrow,
      rightBrow,
      hp: 2,
      alive: true,
      respawnCooldown: 0,
      fallProgress: 0,
      spawnX: x,
      spawnZ: z,
      baseX: x,
      baseZ: z,
      patrolX,
      peekPhase: Math.random() * Math.PI * 2,
      advancePhase: Math.random() * Math.PI * 2,
      fireCooldown: 0.65 + Math.random() * 0.75,
      stunTimer: 0
    });
  }

  /**
   * Увімкнення / вимкнення окулярів нічного бачення AN/PVS-31 (Клавіша [N])
   */
  toggleNightVision() {
    this.nvgActive = !this.nvgActive;
    this.postProcessor.uniforms.uNvgActive.value = this.nvgActive ? 1.0 : 0.0;
    this.nvgWarmup = this.nvgActive ? 1.0 : 0.0;
    this.irLaserBeam.visible = this.nvgActive;

    this.audio.playNvgToggle(this.nvgActive);

    const nvgEl = document.getElementById('axon-nvg-label');
    if (nvgEl) {
      nvgEl.textContent = this.nvgActive ? 'NVG: ON (AN/PVS-31) [N]' : 'NVG: OFF [N]';
      nvgEl.className = this.nvgActive ? 'nvg-on' : 'nvg-off';
    }

    this.showDiegeticThought(
      this.nvgActive
        ? 'ОКУЛЯРИ НІЧНОГО БАЧЕННЯ AN/PVS-31 ОПУЩЕНО // ІЧ-ЛАЗЕР PEQ-15 АКТИВОВАНО'
        : 'ОКУЛЯРИ НІЧНОГО БАЧЕННЯ ПІДНЯТО НА ШОЛОМ'
    );
  }

  /**
   * Заміна світлої карти (автоматично щохвилини або за клавішею [M])
   */
  rotateToNextBrightMap(manual = false) {
    const nextIdx = (this.env.currentMapIndex + 1) % this.env.mapDefinitions.length;
    this.selectMap(nextIdx, true, manual);
  }

  selectMap(mapIndex, announce = true, manual = false) {
    const def = this.env.loadMap(mapIndex);
    this.mapRotationTimer = this.mapRotationDuration;

    // Глітч відеопотоку нагрудної камери при перемиканні локації
    this.postProcessor.uniforms.uSignalGlitch.value = 0.95;
    this.overexposureFlash = 0.65;
    this.audio.playRadioBeep('map_rotate');

    // Повернення гравця на стартову позицію нової карти та оновлення бійців
    this.playerPos.set(0, this.chestHeight, 13.5);
    this.bodyYaw = 0;
    this.bodyPitch = 0;
    this.weaponAimYaw = 0;
    this.weaponAimPitch = 0;
    this.playerHealth = 100;
    this.isDead = false;
    this.postProcessor.clearLensBlood();
    document.getElementById('lens-damage-overlay').classList.add('hidden');

    this.spawnBotsForMode();
    this.updateOSDLabels();

    // Підсвітка активної кнопки карти в меню брифінгу
    document.querySelectorAll('.map-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.map, 10) === this.env.currentMapIndex);
    });

    if (announce) {
      const prefix = manual ? 'РУЧНА ЗМІНА КАРТИ' : 'РОТАЦІЯ КАРТИ (60 СЕК)';
      const nightHint = def.isNight ? ' // НАТИСНІТЬ [N] ДЛЯ ПНБ!' : '';
      this.showDiegeticThought(`${prefix} // ЛОКАЦІЯ: ${def.name}${nightHint}`);
    }
  }

  setGameMode(mode) {
    this.gameMode = mode;
    this.swatScore = 0;
    this.opforScore = 0;
    this.playerKills = 0;
    this.mapRotationTimer = this.mapRotationDuration;
    this.spawnBotsForMode();
    this.updateOSDLabels();

    document.getElementById('mode-tdm-btn').classList.toggle('active', mode === 'tdm');
    document.getElementById('mode-dm-btn').classList.toggle('active', mode === 'dm');
  }

  /**
   * Перемикання типу керування: 'pc' (Клавіатура WASD + Миша), 'joystick' (Стіки + Геймпад) або 'phone' (Кнопки для телефона + Авто 60 Гц)
   */
  setInputMode(mode) {
    this.inputMode = (mode === 'joystick' || mode === 'phone') ? mode : 'pc';

    // Автоматично встановлюємо частоту оновлення екрана 60 Гц при виборі режиму для телефона
    this.lock60Hz = this.inputMode === 'phone';
    const targetDpr = this.lock60Hz
      ? Math.min(window.devicePixelRatio || 1, 1.35)
      : Math.min(window.devicePixelRatio || 1, 2.0);
    this.renderer.setPixelRatio(targetDpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.postProcessor) {
      this.postProcessor.setSize(window.innerWidth, window.innerHeight);
    }

    const pcBtn = document.getElementById('input-pc-btn');
    const joyBtn = document.getElementById('input-joystick-btn');
    const phoneBtn = document.getElementById('input-phone-btn');
    const drawerInputBtn = document.getElementById('drawer-toggle-input-btn');
    const joyHud = document.getElementById('joystick-hud');
    const phoneHud = document.getElementById('phone-hud');
    const whisper = document.getElementById('controls-whisper');
    const hzLabel = document.getElementById('axon-hz-label');
    const phoneHzPill = document.getElementById('phone-hz-pill');

    if (pcBtn) pcBtn.classList.toggle('active', this.inputMode === 'pc');
    if (joyBtn) joyBtn.classList.toggle('active', this.inputMode === 'joystick');
    if (phoneBtn) phoneBtn.classList.toggle('active', this.inputMode === 'phone');
    if (hzLabel) {
      hzLabel.classList.toggle('locked-60hz', this.lock60Hz);
      hzLabel.textContent = this.lock60Hz
        ? 'DISPLAY: 60Hz LOCK (MOBILE)'
        : 'DISPLAY: NATIVE Hz';
    }
    if (phoneHzPill) {
      phoneHzPill.textContent = '⚡ ЕКРАН: 60 ГЦ (АВТО)';
    }

    if (drawerInputBtn) {
      if (this.inputMode === 'joystick') {
        drawerInputBtn.textContent = 'КЕРУВАННЯ: 🎮 ДЖОЙСТИК (СТІКИ / ГЕЙМПАД)';
      } else if (this.inputMode === 'phone') {
        drawerInputBtn.textContent = 'КЕРУВАННЯ: 📱 ТЕЛЕФОН (КНОПКИ // АВТО 60 ГЦ)';
      } else {
        drawerInputBtn.textContent = "КЕРУВАННЯ: 💻 КОМП'ЮТЕР (КЛАВІАТУРА+МИША)";
      }
    }

    if (this.inputMode === 'joystick') {
      if (document.pointerLockElement) document.exitPointerLock();
      this.canvas.style.cursor = 'default';
      if (phoneHud) phoneHud.classList.add('hidden');
      if (this.isRunning && !this.opticsMenuOpen && joyHud) {
        joyHud.classList.remove('hidden');
      }
      if (whisper) whisper.classList.add('hidden');
      this.phoneLookVec.set(0, 0);
    } else if (this.inputMode === 'phone') {
      if (document.pointerLockElement) document.exitPointerLock();
      this.canvas.style.cursor = 'default';
      if (joyHud) joyHud.classList.add('hidden');
      if (this.isRunning && !this.opticsMenuOpen && phoneHud) {
        phoneHud.classList.remove('hidden');
      }
      if (whisper) whisper.classList.add('hidden');
      this.joyLeftVec.set(0, 0);
      this.joyRightVec.set(0, 0);
      this.showDiegeticThought('РЕЖИМ ТЕЛЕФОНА: ЕКРАН АВТОМАТИЧНО ПЕРЕВЕДЕНО НА 60 ГЦ (60 FPS)');
    } else {
      this.canvas.style.cursor = 'crosshair';
      if (joyHud) joyHud.classList.add('hidden');
      if (phoneHud) phoneHud.classList.add('hidden');
      if (whisper) whisper.classList.remove('hidden');
      this.joyLeftVec.set(0, 0);
      this.joyRightVec.set(0, 0);
      this.phoneLookVec.set(0, 0);
      this.joyFiring = false;
    }
  }

  /**
   * Спільна математика вільного прицілювання (Free-Aim) для миші (ПК) та правого джойстика
   */
  applyLookDelta(dx, dy) {
    this.mouseDelta.set(dx * 18.0, dy * 18.0);

    const maxFreeYaw = (this.isAiming ? 0.075 : 0.24) * this.freeAimScale;
    const maxFreePitch = (this.isAiming ? 0.065 : 0.17) * this.freeAimScale;

    this.weaponAimYaw -= dx;
    this.weaponAimPitch -= dy;

    if (Math.abs(this.weaponAimYaw) > maxFreeYaw) {
      const overflow = this.weaponAimYaw - Math.sign(this.weaponAimYaw) * maxFreeYaw;
      this.bodyYaw += overflow;
      this.weaponAimYaw = Math.sign(this.weaponAimYaw) * maxFreeYaw;
    }

    if (Math.abs(this.weaponAimPitch) > maxFreePitch) {
      const overflow = this.weaponAimPitch - Math.sign(this.weaponAimPitch) * maxFreePitch;
      this.bodyPitch = THREE.MathUtils.clamp(this.bodyPitch + overflow, -1.15, 1.15);
      this.weaponAimPitch = Math.sign(this.weaponAimPitch) * maxFreePitch;
    }

    this.bodyYaw += this.weaponAimYaw * 0.14;
    this.weaponAimYaw *= 0.86;
    this.bodyPitch = THREE.MathUtils.clamp(this.bodyPitch + this.weaponAimPitch * 0.12, -1.15, 1.15);
    this.weaponAimPitch *= 0.88;

    this.weaponLagYaw += dx * 0.45;
    this.weaponLagPitch += dy * 0.45;
  }

  updateOSDLabels() {
    const modeLabel = document.getElementById('axon-mode-label');
    const mapLabel = document.getElementById('axon-map-label');
    const scoreDisplay = document.getElementById('axon-score-display');

    const mapDef = this.env.mapDefinitions[this.env.currentMapIndex];
    if (modeLabel) {
      modeLabel.textContent = this.gameMode === 'tdm'
        ? 'MODE: КОМАНДНИЙ БІЙ 5v5'
        : 'MODE: DEATHMATCH (FFA)';
    }
    if (mapLabel && mapDef) {
      mapLabel.textContent = `MAP: ${mapDef.name.split('//')[0].trim()}`;
    }
    if (scoreDisplay) {
      if (this.gameMode === 'tdm') {
        scoreDisplay.textContent = `SWAT (СОЮЗ): ${this.swatScore}  |  OPFOR (ВОРОГ): ${this.opforScore}`;
      } else {
        scoreDisplay.textContent = `DM ФРАГИ: ${this.playerKills}  |  СМЕРТІ: ${this.playerDeaths}`;
      }
    }
  }

  toggleMuteAudio() {
    const muted = this.audio.toggleMute();
    const audioEl = document.getElementById('axon-audio-label');
    if (audioEl) {
      audioEl.textContent = muted ? 'MIC: MUTED [Z]' : 'MIC: ON [Z]';
      audioEl.style.color = muted ? '#ff4d4d' : '#cbd5e1';
    }
    this.showDiegeticThought(
      muted
        ? 'РЕЖИМ БЕЗ ЗВУКУ АКТИВОВАНО // МІКРОФОН AXON BODY 3 ВИМКНЕНО [Z]'
        : 'ЗВУК УВІМКНЕНО // ЗАПИС МІКРОФОНА AXON BODY 3 ВІДНОВЛЕНО [Z]'
    );
  }

  toggleFlashlight() {
    this.flashlightOn = !this.flashlightOn;
    this.flashlight.intensity = this.flashlightOn ? this.flashlightMaxIntensity : 0.0;
    if (this.flashlightSpill) {
      this.flashlightSpill.intensity = this.flashlightOn ? this.flashlightSpillIntensity : 0.0;
    }
    if (this.flashlightBeamCone) {
      this.flashlightBeamCone.visible = this.flashlightOn;
    }
    if (this.flashlightLensMat) {
      this.flashlightLensMat.color.setHex(this.flashlightOn ? 0xffffff : 0x22262b);
    }
    this.audio.playWeaponHandling('dry');
    this.showDiegeticThought(
      this.flashlightOn
        ? 'ТАКТИЧНИЙ ПРОЖЕКТОР SUREFIRE (1500 ЛЮМЕН): УВІМКНЕНО [F]'
        : 'ТАКТИЧНИЙ ПРОЖЕКТОР SUREFIRE: ВИМКНЕНО [F]'
    );
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.postProcessor.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;

      if (e.code === 'Tab') {
        e.preventDefault();
        this.toggleOpticsDrawer();
      }
      if (e.code === 'KeyH') {
        document.getElementById('controls-whisper').classList.toggle('hidden');
      }
      if (e.code === 'KeyZ') {
        this.toggleMuteAudio();
      }

      if (!this.isRunning || this.opticsMenuOpen) return;

      if (e.code === 'KeyN') {
        this.toggleNightVision();
      }
      if (e.code === 'KeyM') {
        this.rotateToNextBrightMap(true);
      }

      if (this.isDead) return;

      if (e.code === 'KeyQ') {
        if (this.leanTarget !== -1) this.audio.playGearRustle(0.24);
        this.leanTarget = -1;
      }
      if (e.code === 'KeyE') {
        if (this.leanTarget !== 1) this.audio.playGearRustle(0.24);
        this.leanTarget = 1;
      }
      if (e.code === 'KeyR') {
        this.triggerReload();
      }
      if (e.code === 'KeyT') {
        this.triggerAmmoCheck();
      }
      if (e.code === 'KeyF') {
        this.toggleFlashlight();
      }
      if (e.code === 'KeyG') {
        this.throwFlashbang();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'KeyQ' && this.leanTarget === -1) {
        this.leanTarget = this.keys['KeyE'] ? 1 : 0;
        this.audio.playGearRustle(0.18);
      }
      if (e.code === 'KeyE' && this.leanTarget === 1) {
        this.leanTarget = this.keys['KeyQ'] ? -1 : 0;
        this.audio.playGearRustle(0.18);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.inputMode !== 'pc') return;
      if (!this.isRunning || this.isDead || this.opticsMenuOpen) return;
      if (document.pointerLockElement !== this.canvas) return;

      const sens = this.isAiming ? 0.0014 : 0.0021;
      this.applyLookDelta(e.movementX * sens, e.movementY * sens);
    });

    window.addEventListener('mousedown', (e) => {
      if (this.inputMode !== 'pc') return;
      if (!this.isRunning || this.isDead || this.opticsMenuOpen) return;
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock();
        return;
      }
      if (e.button === 0) {
        this.fireWeapon();
      } else if (e.button === 2) {
        this.isAiming = true;
        this.audio.playGearRustle(0.2);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.inputMode !== 'pc') return;
      if (e.button === 2) {
        this.isAiming = false;
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Прив'язка сенсорних/екранних джойстиків та фізичного геймпада (Xbox / PlayStation)
   */
  bindJoystickControls() {
    const setupStick = (zoneId, knobId, outVec) => {
      const zone = document.getElementById(zoneId);
      const knob = document.getElementById(knobId);
      if (!zone || !knob) return;

      let activePointerId = null;
      const maxRadius = 46;

      const updateStick = (clientX, clientY) => {
        const rect = zone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        outVec.set(dx / maxRadius, dy / maxRadius);
      };

      const resetStick = () => {
        activePointerId = null;
        knob.style.transform = 'translate(0px, 0px)';
        outVec.set(0, 0);
      };

      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        activePointerId = e.pointerId;
        zone.setPointerCapture(e.pointerId);
        updateStick(e.clientX, e.clientY);
      });

      zone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== activePointerId) return;
        e.preventDefault();
        updateStick(e.clientX, e.clientY);
      });

      zone.addEventListener('pointerup', (e) => {
        if (e.pointerId === activePointerId) resetStick();
      });
      zone.addEventListener('pointercancel', (e) => {
        if (e.pointerId === activePointerId) resetStick();
      });
    };

    setupStick('joy-left-zone', 'joy-left-knob', this.joyLeftVec);
    setupStick('joy-right-zone', 'joy-right-knob', this.joyRightVec);

    const bindBtn = (id, onDown, onUp = null) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onDown(el);
      });
      if (onUp) {
        el.addEventListener('pointerup', (e) => {
          e.preventDefault();
          onUp(el);
        });
        el.addEventListener('pointerleave', () => onUp(el));
      }
    };

    // Вогонь (R2): одноразовий постріл при натисканні + повтор при утриманні
    bindBtn(
      'joy-btn-fire',
      () => {
        if (!this.isDead) this.fireWeapon();
        this.joyFiring = true;
        this.joyFireTimer = 0.16;
      },
      () => {
        this.joyFiring = false;
      }
    );

    // Приціл (L2): перемикання прицілювання
    bindBtn('joy-btn-aim', (el) => {
      this.isAiming = !this.isAiming;
      el.classList.toggle('active', this.isAiming);
      this.audio.playGearRustle(0.2);
    });

    // Нахили корпусу вліво / вправо (L1 / R1)
    bindBtn('joy-btn-lean-l', (el) => {
      this.leanTarget = this.leanTarget === -1 ? 0 : -1;
      el.classList.toggle('active', this.leanTarget === -1);
      document.getElementById('joy-btn-lean-r')?.classList.remove('active');
      this.audio.playGearRustle(0.22);
    });

    bindBtn('joy-btn-lean-r', (el) => {
      this.leanTarget = this.leanTarget === 1 ? 0 : 1;
      el.classList.toggle('active', this.leanTarget === 1);
      document.getElementById('joy-btn-lean-l')?.classList.remove('active');
      this.audio.playGearRustle(0.22);
    });

    bindBtn('joy-btn-reload', () => this.triggerReload());
    bindBtn('joy-btn-check', () => this.triggerAmmoCheck());
    bindBtn('joy-btn-grenade', () => this.throwFlashbang());
    bindBtn('joy-btn-light', () => this.toggleFlashlight());
    bindBtn('joy-btn-nvg', () => this.toggleNightVision());
    bindBtn('joy-btn-map', () => this.rotateToNextBrightMap(true));
    bindBtn('joy-btn-mute', () => this.toggleMuteAudio());
    bindBtn('joy-btn-menu', () => this.toggleOpticsDrawer());

    window.addEventListener('gamepadconnected', (e) => {
      const pill = document.getElementById('gamepad-status-pill');
      if (pill) {
        pill.textContent = `🎮 ГЕЙМПАД ПІДКЛЮЧЕНО: ${e.gamepad.id.slice(0, 24)}`;
      }
      this.showDiegeticThought('ФІЗИЧНИЙ ДЖОЙСТИК / ГЕЙМПАД ПІДКЛЮЧЕНО ТА ГОТОВО ДО БОЮ');
    });
  }

  /**
   * Прив'язка кнопок для режиму «На телефоні» (#phone-hud):
   * кнопкова хрестовина руху, кнопки повороту прицілу, кнопка ВОГОНЬ, свайп-прицілювання по екрану та верхня панель
   */
  bindPhoneControls() {
    const bindHoldBtn = (id, onDown, onUp) => {
      const el = document.getElementById(id);
      if (!el) return;
      const release = () => {
        el.classList.remove('active');
        onUp(el);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('active');
        onDown(el);
      });
      el.addEventListener('pointerup', (e) => {
        e.preventDefault();
        release();
      });
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    };

    const bindTapBtn = (id, onTap) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onTap(el);
      });
    };

    // Кнопки руху (D-Pad): ВПЕРЕД, НАЗАД, ВЛІВО, ВПРАВО
    bindHoldBtn(
      'phone-move-up',
      () => { this.keys['KeyW'] = true; },
      () => { this.keys['KeyW'] = false; }
    );
    bindHoldBtn(
      'phone-move-down',
      () => { this.keys['KeyS'] = true; },
      () => { this.keys['KeyS'] = false; }
    );
    bindHoldBtn(
      'phone-move-left',
      () => { this.keys['KeyA'] = true; },
      () => { this.keys['KeyA'] = false; }
    );
    bindHoldBtn(
      'phone-move-right',
      () => { this.keys['KeyD'] = true; },
      () => { this.keys['KeyD'] = false; }
    );

    // Перемикач БІГ (Спринт) на телефоні
    bindTapBtn('phone-btn-sprint', (el) => {
      this.phoneSprintActive = !this.phoneSprintActive;
      el.classList.toggle('active', this.phoneSprintActive);
    });

    // Нахили корпусу ВЛІВО / ВПРАВО
    bindTapBtn('phone-btn-lean-l', (el) => {
      this.leanTarget = this.leanTarget === -1 ? 0 : -1;
      el.classList.toggle('active', this.leanTarget === -1);
      document.getElementById('phone-btn-lean-r')?.classList.remove('active');
      this.audio.playGearRustle(0.22);
    });
    bindTapBtn('phone-btn-lean-r', (el) => {
      this.leanTarget = this.leanTarget === 1 ? 0 : 1;
      el.classList.toggle('active', this.leanTarget === 1);
      document.getElementById('phone-btn-lean-l')?.classList.remove('active');
      this.audio.playGearRustle(0.22);
    });

    // Кнопки повороту камери та прицілу (ВГОРУ / ВНИЗ / ВЛІВО / ВПРАВО)
    bindHoldBtn(
      'phone-look-up',
      () => { this.phoneLookVec.y = -1; },
      () => { if (this.phoneLookVec.y < 0) this.phoneLookVec.y = 0; }
    );
    bindHoldBtn(
      'phone-look-down',
      () => { this.phoneLookVec.y = 1; },
      () => { if (this.phoneLookVec.y > 0) this.phoneLookVec.y = 0; }
    );
    bindHoldBtn(
      'phone-look-left',
      () => { this.phoneLookVec.x = -1; },
      () => { if (this.phoneLookVec.x < 0) this.phoneLookVec.x = 0; }
    );
    bindHoldBtn(
      'phone-look-right',
      () => { this.phoneLookVec.x = 1; },
      () => { if (this.phoneLookVec.x > 0) this.phoneLookVec.x = 0; }
    );

    // Центральна кнопка ВОГОНЬ (стрільба одиночними або чергою при утриманні)
    bindHoldBtn(
      'phone-btn-fire',
      () => {
        if (!this.isDead) this.fireWeapon();
        this.joyFiring = true;
        this.joyFireTimer = 0.16;
      },
      () => {
        this.joyFiring = false;
      }
    );

    // Тактичні кнопки справа: Приціл, Перезарядка, Магазин, Граната
    bindTapBtn('phone-btn-aim', (el) => {
      this.isAiming = !this.isAiming;
      el.classList.toggle('active', this.isAiming);
      this.audio.playGearRustle(0.2);
    });
    bindTapBtn('phone-btn-reload', () => this.triggerReload());
    bindTapBtn('phone-btn-check', () => this.triggerAmmoCheck());
    bindTapBtn('phone-btn-grenade', () => this.throwFlashbang());

    // Верхня панель швидких дій на телефоні
    bindTapBtn('phone-btn-menu', () => this.toggleOpticsDrawer());
    bindTapBtn('phone-btn-nvg', () => this.toggleNightVision());
    bindTapBtn('phone-btn-map', () => this.rotateToNextBrightMap(true));
    bindTapBtn('phone-btn-light', () => this.toggleFlashlight());
    bindTapBtn('phone-btn-mute', () => this.toggleMuteAudio());
    bindTapBtn('phone-btn-fullscreen', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    });

    // Додатково: свайп пальцем безпосередньо по 3D-екрану в режимі телефона або джойстика для швидкого огляду
    let touchLookPointerId = null;
    let lastTouchX = 0;
    let lastTouchY = 0;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.inputMode === 'pc') return;
      if (!this.isRunning || this.isDead || this.opticsMenuOpen) return;
      touchLookPointerId = e.pointerId;
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.inputMode === 'pc' || e.pointerId !== touchLookPointerId) return;
      if (!this.isRunning || this.isDead || this.opticsMenuOpen) return;
      const dx = e.clientX - lastTouchX;
      const dy = e.clientY - lastTouchY;
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;
      const sens = this.isAiming ? 0.0024 : 0.0038;
      this.applyLookDelta(dx * sens, dy * sens);
    });

    const endTouchLook = (e) => {
      if (e.pointerId === touchLookPointerId) {
        touchLookPointerId = null;
      }
    };
    this.canvas.addEventListener('pointerup', endTouchLook);
    this.canvas.addEventListener('pointercancel', endTouchLook);
  }

  /**
   * Опитування фізичного геймпада (HTML5 Gamepad API), екранних джойстиків та кнопок телефона щокадру
   */
  pollGamepadAndJoystick(dt) {
    // 1. Обробка правого екранного джойстика (Free-Aim поворот зброї та корпусу)
    if (this.inputMode === 'joystick' && this.joyRightVec.lengthSq() > 0.002) {
      const lookSpeed = (this.isAiming ? 1.55 : 2.55) * dt;
      this.applyLookDelta(this.joyRightVec.x * lookSpeed, this.joyRightVec.y * lookSpeed);
    }

    // 1b. Обробка кнопок повороту прицілу в режимі «На телефоні»
    if (this.inputMode === 'phone' && this.phoneLookVec.lengthSq() > 0.001) {
      const lookSpeed = (this.isAiming ? 1.35 : 2.25) * dt;
      this.applyLookDelta(this.phoneLookVec.x * lookSpeed, this.phoneLookVec.y * lookSpeed);
    }

    // Автоматична стрільба при утриманні кнопки ВОГОНЬ на джойстику або телефоні
    if (this.joyFiring && !this.isDead) {
      this.joyFireTimer -= dt;
      if (this.joyFireTimer <= 0) {
        this.joyFireTimer = 0.14;
        this.fireWeapon();
      }
    }

    // 2. Опитування фізичного геймпада Xbox / PlayStation (якщо підключений по USB або Bluetooth)
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const gp = pads ? (pads[0] || pads[1] || pads[2] || pads[3]) : null;
    if (!gp) return;

    this.activeGamepad = gp;
    const dz = (v) => (Math.abs(v) < 0.14 ? 0 : v);

    // Правий стік фізичного геймпада (axes[2], axes[3])
    const rx = dz(gp.axes[2] || 0);
    const ry = dz(gp.axes[3] || 0);
    if (rx !== 0 || ry !== 0) {
      const lookSpeed = (this.isAiming ? 1.65 : 2.75) * dt;
      this.applyLookDelta(rx * lookSpeed, ry * lookSpeed);
    }

    const isPressed = (idx) => Boolean(gp.buttons[idx] && gp.buttons[idx].pressed);
    const justPressed = (idx) => isPressed(idx) && !this.prevGamepadButtons[idx];

    // R2 (7) — Вогонь, L2 (6) — Приціл
    if (justPressed(7)) this.fireWeapon();
    if (gp.buttons[6]) {
      this.isAiming = gp.buttons[6].pressed;
    }

    // L1 (4) / R1 (5) — Нахили корпусу вліво / вправо
    if (justPressed(4)) {
      this.leanTarget = this.leanTarget === -1 ? 0 : -1;
      this.audio.playGearRustle(0.2);
    }
    if (justPressed(5)) {
      this.leanTarget = this.leanTarget === 1 ? 0 : 1;
      this.audio.playGearRustle(0.2);
    }

    // X / Square (2) — Перезарядка, Y / Triangle (3) — Огляд магазину, B / Circle (1) — Граната
    if (justPressed(2)) this.triggerReload();
    if (justPressed(3)) this.triggerAmmoCheck();
    if (justPressed(1)) this.throwFlashbang();

    // Хрестовина D-Pad: Up (12) Ліхтар, Down (13) Звук, Left (14) ПНБ, Right (15) Карта, Start (9) Меню
    if (justPressed(12)) {
      this.toggleFlashlight();
    }
    if (justPressed(13)) this.toggleMuteAudio();
    if (justPressed(14)) this.toggleNightVision();
    if (justPressed(15)) this.rotateToNextBrightMap(true);
    if (justPressed(9)) this.toggleOpticsDrawer();

    for (let i = 0; i < gp.buttons.length; i++) {
      this.prevGamepadButtons[i] = Boolean(gp.buttons[i] && gp.buttons[i].pressed);
    }
  }

  bindUI() {
    const startBtn = document.getElementById('start-operation-btn');
    const retryBtn = document.getElementById('retry-operation-btn');
    const backBriefingBtn = document.getElementById('back-to-briefing-btn');
    const inputPcBtn = document.getElementById('input-pc-btn');
    const inputJoyBtn = document.getElementById('input-joystick-btn');
    const inputPhoneBtn = document.getElementById('input-phone-btn');
    const modeTdmBtn = document.getElementById('mode-tdm-btn');
    const modeDmBtn = document.getElementById('mode-dm-btn');
    const closeOpticsBtn = document.getElementById('close-optics-btn');
    const drawerToggleInputBtn = document.getElementById('drawer-toggle-input-btn');
    const drawerToggleModeBtn = document.getElementById('drawer-toggle-mode-btn');
    const drawerNextMapBtn = document.getElementById('drawer-next-map-btn');
    const drawerToggleNvgBtn = document.getElementById('drawer-toggle-nvg-btn');
    const spawnWaveBtn = document.getElementById('spawn-wave-btn');

    if (inputPcBtn) inputPcBtn.addEventListener('click', () => this.setInputMode('pc'));
    if (inputJoyBtn) inputJoyBtn.addEventListener('click', () => this.setInputMode('joystick'));
    if (inputPhoneBtn) inputPhoneBtn.addEventListener('click', () => this.setInputMode('phone'));

    modeTdmBtn.addEventListener('click', () => this.setGameMode('tdm'));
    modeDmBtn.addEventListener('click', () => this.setGameMode('dm'));

    document.querySelectorAll('.map-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.map, 10);
        this.selectMap(idx, false, true);
      });
    });

    startBtn.addEventListener('click', () => {
      this.startOperation();
    });

    retryBtn.addEventListener('click', () => {
      this.resetOperation();
      this.startOperation();
    });

    backBriefingBtn.addEventListener('click', () => {
      document.getElementById('endgame-modal').classList.add('hidden');
      document.getElementById('briefing-modal').classList.remove('hidden');
      document.getElementById('joystick-hud')?.classList.add('hidden');
      document.getElementById('phone-hud')?.classList.add('hidden');
      this.resetOperation();
    });

    closeOpticsBtn.addEventListener('click', () => {
      this.toggleOpticsDrawer(false);
    });

    if (drawerToggleInputBtn) {
      drawerToggleInputBtn.addEventListener('click', () => {
        const nextInput = this.inputMode === 'pc'
          ? 'joystick'
          : (this.inputMode === 'joystick' ? 'phone' : 'pc');
        this.setInputMode(nextInput);
        if (nextInput === 'joystick') {
          this.showDiegeticThought('УВІМКНЕНО РЕЖИМ ДЖОЙСТИКА (ЕКРАННІ СТІКИ ТА ГЕЙМПАД XBOX/PS)');
        } else if (nextInput === 'phone') {
          this.showDiegeticThought('УВІМКНЕНО РЕЖИМ НА ТЕЛЕФОНІ (КНОПКОВЕ КЕРУВАННЯ ТА СЕНСОРНИЙ ОГЛЯД)');
        } else {
          this.showDiegeticThought("УВІМКНЕНО РЕЖИМ КОМП'ЮТЕРА (КЛАВІАТУРА WASD ТА МИША)");
        }
      });
    }

    drawerToggleModeBtn.addEventListener('click', () => {
      const nextMode = this.gameMode === 'tdm' ? 'dm' : 'tdm';
      this.setGameMode(nextMode);
      this.showDiegeticThought(
        nextMode === 'tdm'
          ? 'АКТИВОВАНО РЕЖИМ: КОМАНДНИЙ БІЙ 5v5 (SWAT vs OPFOR)'
          : 'АКТИВОВАНО РЕЖИМ: DEATHMATCH + ЗАМІНА КАРТИ КОЖНІ 60 СЕК'
      );
    });

    drawerNextMapBtn.addEventListener('click', () => {
      this.rotateToNextBrightMap(true);
    });

    drawerToggleNvgBtn.addEventListener('click', () => {
      this.toggleNightVision();
    });

    spawnWaveBtn.addEventListener('click', () => {
      this.resetOperation();
      this.toggleOpticsDrawer(false);
      this.startOperation();
    });

    const bindSlider = (id, valId, cb) => {
      const el = document.getElementById(id);
      const valEl = document.getElementById(valId);
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        valEl.textContent = v.toFixed(2);
        cb(v);
      });
    };

    bindSlider('opt-fisheye', 'val-fisheye', (v) => {
      this.postProcessor.uniforms.uFisheye.value = v;
    });
    bindSlider('opt-chroma', 'val-chroma', (v) => {
      this.postProcessor.uniforms.uChroma.value = v;
    });
    bindSlider('opt-grain', 'val-grain', (v) => {
      this.postProcessor.uniforms.uGrain.value = v;
    });
    bindSlider('opt-exposure', 'val-exposure', (v) => {
      this.userExposureMultiplier = v;
    });
    bindSlider('opt-freeaim', 'val-freeaim', (v) => {
      this.freeAimScale = v;
    });
    bindSlider('opt-micclip', 'val-micclip', (v) => {
      this.audio.updateClipCurve(v);
    });
  }

  toggleOpticsDrawer(forceState) {
    const drawer = document.getElementById('optics-drawer');
    const joyHud = document.getElementById('joystick-hud');
    const phoneHud = document.getElementById('phone-hud');
    this.opticsMenuOpen = typeof forceState === 'boolean' ? forceState : drawer.classList.contains('hidden');
    if (this.opticsMenuOpen) {
      drawer.classList.remove('hidden');
      if (joyHud) joyHud.classList.add('hidden');
      if (phoneHud) phoneHud.classList.add('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      drawer.classList.add('hidden');
      if (this.isRunning && !this.isDead) {
        if (this.inputMode === 'joystick') {
          if (joyHud) joyHud.classList.remove('hidden');
        } else if (this.inputMode === 'phone') {
          if (phoneHud) phoneHud.classList.remove('hidden');
        } else {
          this.canvas.requestPointerLock();
        }
      }
    }
  }

  startOperation() {
    this.audio.init();
    document.getElementById('briefing-modal').classList.add('hidden');
    document.getElementById('endgame-modal').classList.add('hidden');
    this.isRunning = true;

    const joyHud = document.getElementById('joystick-hud');
    const phoneHud = document.getElementById('phone-hud');
    const whisper = document.getElementById('controls-whisper');
    if (this.inputMode === 'joystick') {
      if (joyHud) joyHud.classList.remove('hidden');
      if (phoneHud) phoneHud.classList.add('hidden');
      if (whisper) whisper.classList.add('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (this.inputMode === 'phone') {
      if (phoneHud) phoneHud.classList.remove('hidden');
      if (joyHud) joyHud.classList.add('hidden');
      if (whisper) whisper.classList.add('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      if (joyHud) joyHud.classList.add('hidden');
      if (phoneHud) phoneHud.classList.add('hidden');
      if (whisper) whisper.classList.remove('hidden');
      this.canvas.requestPointerLock();
    }
  }

  resetOperation() {
    this.isDead = false;
    this.playerHealth = 100;
    this.damagePulse = 0;
    this.concussionAmount = 0;
    this.deathFallProgress = 0;
    this.playerPos.set(0, this.chestHeight, 13.5);
    this.bodyYaw = 0;
    this.bodyPitch = 0;
    this.weaponAimYaw = 0;
    this.weaponAimPitch = 0;
    this.currentAmmo = 30;
    this.reserveMags = 5;
    this.grenadesLeft = 3;
    this.mapRotationTimer = this.mapRotationDuration;
    this.postProcessor.clearLensBlood();
    document.getElementById('lens-damage-overlay').classList.add('hidden');
    this.spawnBotsForMode();
    this.updateOSDLabels();
  }

  /**
   * Постріл гравця за напрямком ствола зброї (Free-Aim Raycast)
   */
  fireWeapon() {
    if (this.isReloading || this.isCheckingAmmo) return;

    if (this.currentAmmo <= 0) {
      this.audio.playWeaponHandling('dry');
      this.showDiegeticThought('КЛАЦ! ПАТРОННИК ПОРОЖНІЙ — НАТИСНІТЬ [R] ДЛЯ ЗМІНИ МАГАЗИНУ');
      return;
    }

    this.currentAmmo--;
    this.updateMagVisualBullets();

    this.audio.playGunshot(true, 0);

    this.muzzleFlashMesh.material.opacity = 0.95;
    this.muzzleFlashMesh.rotation.z = Math.random() * Math.PI * 2;
    this.muzzleLight.intensity = 10.0;
    this.overexposureFlash = Math.min(0.85, this.overexposureFlash + 0.14);
    this.postProcessor.uniforms.uSignalGlitch.value = 0.28;

    const recoilMult = this.isAiming ? 0.72 : 1.15;
    this.recoilPitch += (0.052 + Math.random() * 0.022) * recoilMult;
    this.recoilYaw += (Math.random() - 0.5) * 0.044 * recoilMult;
    this.recoilKickBack = 0.052;
    this.boltCarrier.position.z = -0.12;

    this.cameraShake.x += (Math.random() - 0.5) * 0.04;
    this.cameraShake.y += 0.028 + Math.random() * 0.018;
    this.cameraShake.z += (Math.random() - 0.5) * 0.05;

    const casingOrigin = new THREE.Vector3();
    this.boltCarrier.getWorldPosition(casingOrigin);
    const rightVec = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    const upVec = new THREE.Vector3(0, 1, 0);
    this.env.spawnShellCasing(casingOrigin, rightVec, upVec);

    const barrelQuat = new THREE.Quaternion();
    this.weaponMeshGroup.getWorldQuaternion(barrelQuat);
    const shootDir = new THREE.Vector3(0, 0, -1).applyQuaternion(barrelQuat).normalize();

    const rayOrigin = new THREE.Vector3();
    this.camera.getWorldPosition(rayOrigin);
    this.raycaster.set(rayOrigin, shootDir);

    const hitTargets = [];
    for (const c of this.env.colliders) {
      hitTargets.push(c.mesh);
    }
    for (const bot of this.bots) {
      if (bot.alive) {
        hitTargets.push(bot.head, bot.torso, bot.legs);
      }
    }

    const intersects = this.raycaster.intersectObjects(hitTargets, false);
    if (intersects.length > 0) {
      const hit = intersects[0];
      const hitBot = this.bots.find(
        (b) => b.alive && (hit.object === b.head || hit.object === b.torso || hit.object === b.legs)
      );

      if (hitBot) {
        if (hitBot.isAlly) {
          this.showDiegeticThought('УВАГА! ПРИПИНИТИ ВОГОНЬ ПО СОЮЗНИКАХ SWAT (СИНІЙ ШОЛОМ)!');
          return;
        }

        const isHeadshot = hit.object === hitBot.head;
        hitBot.hp -= isHeadshot ? 2 : 1;

        // Передаємо вектор кулі shootDir для Niagara-аерозолю (Blood Mist), балістичних крапель та DBuffer-декалей
        this.env.spawnBulletImpact(hit.point, shootDir.clone().negate(), true, shootDir);
        this.audio.playImpact('flesh');

        // Якщо бій відбувається на близькій дистанції — краплі крові летять на об'єктив нагрудної камери та стікають вниз!
        if (hit.distance < 7.2) {
          this.postProcessor.addLensBloodSplatter(isHeadshot ? 4 : 2);
        }

        if (hitBot.hp <= 0) {
          this.onBotKilled(hitBot, 'player');
        }
      } else {
        const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        this.env.spawnBulletImpact(hit.point, normal, false, shootDir);
        this.audio.playImpact('concrete');
      }
    }
  }

  onBotKilled(bot, killerType = 'player') {
    bot.alive = false;
    bot.respawnCooldown = 3.6; // Швидкий респавн у командному бою та Deathmatch
    bot.fallProgress = 0;

    if (!bot.isAlly) {
      this.swatScore++;
      if (killerType === 'player') {
        this.playerKills++;
        this.audio.playRadioBeep('kill');
      }
    } else {
      this.opforScore++;
    }
    this.updateOSDLabels();
  }

  respawnBot(bot) {
    bot.alive = true;
    bot.hp = 2;
    bot.fallProgress = 0;
    bot.group.rotation.x = 0;
    bot.group.rotation.z = 0;
    bot.group.position.set(
      bot.spawnX + (Math.random() - 0.5) * 2.4,
      0,
      bot.spawnZ + (Math.random() - 0.5) * 1.8
    );
  }

  triggerReload() {
    if (this.isReloading || this.reserveMags <= 0 || this.currentAmmo === this.magCapacity) return;
    this.isReloading = true;
    this.isCheckingAmmo = false;
    this.reloadTimer = 1.55;
    this.audio.playWeaponHandling('reload');
  }

  triggerAmmoCheck() {
    if (this.isReloading || this.isCheckingAmmo) return;
    this.isCheckingAmmo = true;
    this.checkAmmoTimer = 1.8;
    this.updateMagVisualBullets();
    this.audio.playWeaponHandling('check');

    let statusText = '';
    if (this.currentAmmo === 0) {
      statusText = 'МАГАЗИН ПОРОЖНІЙ';
    } else if (this.currentAmmo > 24) {
      statusText = `МАГАЗИН МАЙЖЕ ПОВНИЙ (~${this.currentAmmo} НАБ.)`;
    } else if (this.currentAmmo >= 12) {
      statusText = `БЛИЗЬКО ПОЛОВИНИ МАГАЗИНУ (~${this.currentAmmo} НАБ.)`;
    } else {
      statusText = `МАЛО НАБОЇВ У МАГАЗИНІ! (~${this.currentAmmo} НАБ.)`;
    }
    this.showDiegeticThought(`${statusText} // ЗАПАСНИХ МАГАЗИНІВ: ${this.reserveMags}`);
  }

  updateMagVisualBullets() {
    const ratio = this.currentAmmo / this.magCapacity;
    const visibleCount = Math.ceil(ratio * this.magBulletMeshes.length);
    for (let i = 0; i < this.magBulletMeshes.length; i++) {
      this.magBulletMeshes[i].visible = i < visibleCount;
    }
  }

  showDiegeticThought(text) {
    const el = document.getElementById('diegetic-thought');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this.thoughtTimeout);
    this.thoughtTimeout = setTimeout(() => {
      el.classList.add('hidden');
    }, 2600);
  }

  throwFlashbang() {
    if (this.grenadesLeft <= 0) {
      this.showDiegeticThought('СВІТЛОШУМОВІ ГРАНАТИ ЗАКІНЧИЛИСЯ');
      return;
    }
    this.grenadesLeft--;
    this.audio.playGearRustle(0.35);

    const grenMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 0.11, 10),
      new THREE.MeshStandardMaterial({ color: 0x3b4238, metalness: 0.6, roughness: 0.4 })
    );

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0.15, -1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion())).normalize();

    grenMesh.position.copy(origin).addScaledVector(dir, 0.5);
    this.scene.add(grenMesh);

    this.activeGrenades.push({
      mesh: grenMesh,
      vel: dir.multiplyScalar(11.5),
      fuse: 1.45
    });
  }

  detonateFlashbang(grenade) {
    const pos = grenade.mesh.position.clone();
    this.scene.remove(grenade.mesh);

    const distToPlayer = pos.distanceTo(this.playerPos);
    this.audio.playFlashbangExplosion(distToPlayer);

    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    const toFlash = pos.clone().sub(this.playerPos).normalize();
    const lookDot = Math.max(0.2, camDir.dot(toFlash) * 0.5 + 0.5);
    const flashPower = Math.min(1.35, (12.0 / Math.max(distToPlayer, 2.5)) * lookDot);

    this.overexposureFlash = Math.min(1.4, this.overexposureFlash + flashPower);
    this.concussionAmount = Math.min(1.0, this.concussionAmount + flashPower * 0.85);
    this.cameraShake.set((Math.random() - 0.5) * 0.25, 0.18, (Math.random() - 0.5) * 0.25);

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const d = bot.group.position.distanceTo(pos);
      if (d < 8.5) {
        bot.stunTimer = 4.2;
        if (d < 3.5 && !bot.isAlly) {
          this.onBotKilled(bot, 'player');
        }
      }
    }
  }

  /**
   * Влучання по гравцю з тактичним респавном через 2.2 секунди,
   * щоб командний бій та хвилинна ротація карт у Deathmatch не переривалися!
   */
  onPlayerHit() {
    if (this.isDead) return;
    this.playerHealth -= 55;
    this.damagePulse = 1.0;
    this.concussionAmount = Math.min(1.0, this.concussionAmount + 0.48);
    this.postProcessor.uniforms.uSignalGlitch.value = 0.75;

    // Краплі крові на склі нагрудної камери (заломлюють сцену та стікають вниз під дією гравітації)
    this.postProcessor.addLensBloodSplatter(4);

    document.getElementById('lens-damage-overlay').classList.remove('hidden');
    this.cameraShake.set((Math.random() - 0.5) * 0.22, -0.14, (Math.random() - 0.5) * 0.28);
    this.audio.playImpact('flesh');

    if (this.playerHealth <= 0) {
      this.isDead = true;
      this.respawnTimer = 2.2;
      this.playerDeaths++;
      this.opforScore++;
      this.updateOSDLabels();
      this.audio.playImpact('bodycam_drop');
      this.showDiegeticThought('ОПЕРАТОР ПОРАНЕНИЙ // ТАКТИЧНА ЕВАКУАЦІЯ ТА РЕСПАВН (2 СЕК)...');
    }
  }

  respawnPlayer() {
    this.isDead = false;
    this.playerHealth = 100;
    this.deathFallProgress = 0;
    this.currentAmmo = this.magCapacity;
    this.reserveMags = Math.max(this.reserveMags, 4);
    this.grenadesLeft = Math.max(this.grenadesLeft, 2);
    this.updateMagVisualBullets();
    this.postProcessor.clearLensBlood();

    // Безпечна точка респавну на боці SWAT або випадкова у DM
    const spawnX = (Math.random() - 0.5) * 8.0;
    this.playerPos.set(spawnX, this.chestHeight, 13.5);
    this.bodyYaw = 0;
    this.bodyPitch = 0;
    document.getElementById('lens-damage-overlay').classList.add('hidden');
    this.postProcessor.uniforms.uSignalGlitch.value = 0.45;
  }

  /**
   * Таймер автоматичної заміни світлої карти кожні 60 секунд (1 хвилину)
   */
  updateMapRotationTimer(dt) {
    this.mapRotationTimer -= dt;
    if (this.mapRotationTimer <= 0) {
      this.rotateToNextBrightMap(false);
    }

    const secLeft = Math.max(0, Math.ceil(this.mapRotationTimer));
    const mm = String(Math.floor(secLeft / 60)).padStart(2, '0');
    const ss = String(secLeft % 60).padStart(2, '0');
    const timerEl = document.getElementById('axon-map-timer');
    if (timerEl) {
      timerEl.textContent = `ЗМІНА КАРТИ: ${mm}:${ss} [M]`;
    }
  }

  updateAutoExposure(dt) {
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    let targetSceneLuma = 0.42;

    // Якщо гравець піднімає погляд до яскравого сонячного неба — матриця підсліплюється
    if (camDir.y > 0.28) {
      targetSceneLuma += (camDir.y - 0.28) * 1.15;
    }

    const lumaJump = targetSceneLuma - this.adaptedLuma;
    if (lumaJump > 0.32) {
      this.overexposureFlash = Math.min(1.0, this.overexposureFlash + lumaJump * dt * 2.5);
    }

    this.adaptedLuma = THREE.MathUtils.lerp(this.adaptedLuma, targetSceneLuma, dt * 1.4);

    const computedExposure = THREE.MathUtils.clamp((0.52 / Math.max(this.adaptedLuma, 0.22)) * this.userExposureMultiplier, 0.75, 1.85);
    this.postProcessor.uniforms.uExposure.value = computedExposure;

    this.overexposureFlash = Math.max(0.0, this.overexposureFlash - dt * 0.72);
    this.postProcessor.uniforms.uOverexposureFlash.value = this.overexposureFlash;

    if (this.nvgWarmup > 0) {
      this.nvgWarmup = Math.max(0, this.nvgWarmup - dt * 2.2);
      this.postProcessor.uniforms.uNvgWarmup.value = this.nvgWarmup;
    }
  }

  updatePlayerMovement(dt) {
    if (this.isDead) {
      this.deathFallProgress = Math.min(1.0, this.deathFallProgress + dt * 2.8);
      this.cameraRig.position.y = THREE.MathUtils.lerp(this.chestHeight, 0.22, this.deathFallProgress);
      this.cameraRig.rotation.z = THREE.MathUtils.lerp(0, 1.15, this.deathFallProgress);
      this.cameraRig.rotation.x = THREE.MathUtils.lerp(this.bodyPitch, -0.45, this.deathFallProgress);

      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.respawnPlayer();
      }
      return;
    }

    const forward = new THREE.Vector3(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw));
    const right = new THREE.Vector3(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw));

    const moveInput = new THREE.Vector3();
    if (this.keys['KeyW']) moveInput.add(forward);
    if (this.keys['KeyS']) moveInput.sub(forward);
    if (this.keys['KeyD']) moveInput.add(right);
    if (this.keys['KeyA']) moveInput.sub(right);

    // Рух від лівого екранного джойстика (якщо обрано режим ДЖОЙСТИК)
    let joystickSprint = false;
    if (this.inputMode === 'joystick' && this.joyLeftVec.lengthSq() > 0.01) {
      moveInput.addScaledVector(right, this.joyLeftVec.x);
      moveInput.addScaledVector(forward, -this.joyLeftVec.y);
      if (this.joyLeftVec.length() > 0.82) {
        joystickSprint = true;
      }
    }

    // Рух від лівого стіка фізичного геймпада Xbox / PlayStation
    if (this.activeGamepad && this.activeGamepad.axes) {
      const gx = Math.abs(this.activeGamepad.axes[0] || 0) > 0.14 ? this.activeGamepad.axes[0] : 0;
      const gy = Math.abs(this.activeGamepad.axes[1] || 0) > 0.14 ? this.activeGamepad.axes[1] : 0;
      if (gx !== 0 || gy !== 0) {
        moveInput.addScaledVector(right, gx);
        moveInput.addScaledVector(forward, -gy);
        if (Math.hypot(gx, gy) > 0.85 || (this.activeGamepad.buttons[10] && this.activeGamepad.buttons[10].pressed)) {
          joystickSprint = true;
        }
      }
    }

    const isMoving = moveInput.lengthSq() > 0.001;
    const isSprinting =
      isMoving &&
      (this.keys['ShiftLeft'] ||
        this.keys['ShiftRight'] ||
        joystickSprint ||
        (this.inputMode === 'phone' && this.phoneSprintActive)) &&
      !this.isAiming &&
      this.leanTarget === 0;
    const moveSpeed = isSprinting ? 4.55 : (this.isAiming ? 2.2 : 3.25);

    if (isMoving) {
      moveInput.normalize().multiplyScalar(moveSpeed * dt);
      this.tryMoveWithCollisions(moveInput);

      const bobFreq = isSprinting ? 11.5 : 7.6;
      this.walkCycle += dt * bobFreq;
      this.stepAccum += dt * bobFreq;

      if (this.stepAccum >= Math.PI) {
        this.stepAccum -= Math.PI;
        const inPuddle = this.env.isPointInPuddle(this.playerPos.x, this.playerPos.z);
        this.audio.playFootstep(inPuddle, isSprinting);
      }
    } else {
      this.walkCycle += dt * 1.6;
    }

    this.leanCurrent = THREE.MathUtils.lerp(this.leanCurrent, this.leanTarget, dt * 8.5);
    const leanOffset = right.clone().multiplyScalar(this.leanCurrent * 0.36);

    const bobAmp = isMoving ? (isSprinting ? 0.048 : 0.026) : 0.004;
    const bobY = Math.abs(Math.cos(this.walkCycle * 2.0)) * bobAmp;
    const bobRoll = Math.sin(this.walkCycle) * (isMoving ? (isSprinting ? 0.042 : 0.022) : 0.003);

    this.cameraRig.position.copy(this.playerPos).add(leanOffset);
    this.cameraRig.position.y = this.chestHeight - bobY + this.cameraShake.y;

    this.cameraRig.rotation.order = 'YXZ';
    this.cameraRig.rotation.y = this.bodyYaw + this.cameraShake.x;
    this.cameraRig.rotation.x = this.bodyPitch + this.cameraShake.y * 0.6;
    this.cameraRig.rotation.z = -this.leanCurrent * 0.28 + bobRoll + this.cameraShake.z;

    this.cameraShake.lerp(new THREE.Vector3(0, 0, 0), dt * 14.0);
    this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, 0, dt * 11.0);
    this.recoilYaw = THREE.MathUtils.lerp(this.recoilYaw, 0, dt * 11.0);
    this.recoilKickBack = THREE.MathUtils.lerp(this.recoilKickBack, 0, dt * 16.0);
    this.weaponLagYaw = THREE.MathUtils.lerp(this.weaponLagYaw, 0, dt * 12.0);
    this.weaponLagPitch = THREE.MathUtils.lerp(this.weaponLagPitch, 0, dt * 12.0);
    this.boltCarrier.position.z = THREE.MathUtils.lerp(this.boltCarrier.position.z, -0.18, dt * 24.0);

    let targetWepPos = new THREE.Vector3(0.085, 0.045, -0.06);
    let targetWepRotZ = 0.12;

    if (this.isAiming) {
      // Якщо увімкнено ПНБ [N], боєць використовує бокове прицілювання за ІЧ-лазером (Point Shooting)!
      if (this.nvgActive) {
        targetWepPos.set(0.035, 0.055, -0.04);
        targetWepRotZ = 0.42;
      } else {
        targetWepPos.set(0.0, 0.068, -0.03);
        targetWepRotZ = 0.03;
      }
    }

    if (this.isReloading) {
      this.reloadTimer -= dt;
      const phase = Math.sin((1.0 - this.reloadTimer / 1.55) * Math.PI);
      targetWepPos.set(-0.04, -0.08 * phase, -0.08);
      targetWepRotZ = 0.65 * phase;
      if (this.reloadTimer <= 0) {
        this.isReloading = false;
        this.reserveMags--;
        this.currentAmmo = this.magCapacity;
        this.updateMagVisualBullets();
      }
    } else if (this.isCheckingAmmo) {
      this.checkAmmoTimer -= dt;
      const p = Math.min(1.0, Math.sin((1.0 - this.checkAmmoTimer / 1.8) * Math.PI) * 1.35);
      targetWepPos.set(-0.02, 0.095, -0.12);
      targetWepRotZ = 0.92 * p;
      this.magGroup.position.y = -0.115 - 0.065 * p;
      this.magGroup.position.x = 0.055 * p;
      if (this.checkAmmoTimer <= 0) {
        this.isCheckingAmmo = false;
        this.magGroup.position.set(0, -0.115, -0.23);
      }
    } else {
      this.magGroup.position.set(0, -0.115, -0.23);
    }

    this.weaponMeshGroup.position.lerp(targetWepPos, dt * 14.0);
    this.weaponMeshGroup.position.z += this.recoilKickBack;
    this.weaponMeshGroup.position.y += Math.sin(this.walkCycle * 2.0) * (isMoving ? 0.008 : 0.002);

    this.weaponMeshGroup.rotation.order = 'YXZ';
    this.weaponMeshGroup.rotation.y = this.weaponAimYaw - this.weaponLagYaw + this.recoilYaw;
    this.weaponMeshGroup.rotation.x = this.weaponAimPitch - this.weaponLagPitch + this.recoilPitch;
    this.weaponMeshGroup.rotation.z = THREE.MathUtils.lerp(this.weaponMeshGroup.rotation.z, targetWepRotZ, dt * 12.0);

    if (this.muzzleFlashMesh.material.opacity > 0) {
      this.muzzleFlashMesh.material.opacity = Math.max(0, this.muzzleFlashMesh.material.opacity - dt * 18.0);
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 160.0);
    }

    const combatStress = (isSprinting ? 0.65 : 0.22) + (this.playerHealth < 100 ? 0.45 : 0) + this.concussionAmount * 0.5;
    this.combatStressLevel = combatStress;
    this.audio.updateBreathing(dt, combatStress);
  }

  tryMoveWithCollisions(deltaVec) {
    const testX = this.playerPos.clone();
    testX.x += deltaVec.x;
    if (!this.checkSphereCollision(testX)) {
      this.playerPos.x = testX.x;
    }

    const testZ = this.playerPos.clone();
    testZ.z += deltaVec.z;
    if (!this.checkSphereCollision(testZ)) {
      this.playerPos.z = testZ.z;
    }
  }

  checkSphereCollision(pos) {
    const sphere = new THREE.Sphere(new THREE.Vector3(pos.x, 1.0, pos.z), this.playerRadius);
    for (const c of this.env.colliders) {
      if (c.box.intersectsSphere(sphere)) return true;
    }
    return false;
  }

  /**
   * ШІ командного бою (SWAT проти OPFOR) та Deathmatch
   */
  updateAIAndGrenades(dt, elapsed) {
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i];
      g.fuse -= dt;
      g.vel.y -= 9.8 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += 8 * dt;
      g.mesh.rotation.z += 6 * dt;

      if (g.mesh.position.y < 0.06) {
        g.mesh.position.y = 0.06;
        g.vel.y = Math.abs(g.vel.y) * 0.35;
        g.vel.x *= 0.65;
        g.vel.z *= 0.65;
      }

      if (g.fuse <= 0) {
        this.detonateFlashbang(g);
        this.activeGrenades.splice(i, 1);
      }
    }

    const wallMeshes = this.env.colliders.map((c) => c.mesh);

    for (const bot of this.bots) {
      if (!bot.alive) {
        if (bot.fallProgress < 1.0) {
          bot.fallProgress = Math.min(1.0, bot.fallProgress + dt * 4.5);
          bot.group.rotation.x = -bot.fallProgress * (Math.PI / 2.05);
          bot.group.position.y = -bot.fallProgress * 0.12;
        }
        bot.flash.material.opacity = 0;

        bot.respawnCooldown -= dt;
        if (bot.respawnCooldown <= 0) {
          this.respawnBot(bot);
        }
        continue;
      }

      if (bot.flash.material.opacity > 0) {
        bot.flash.material.opacity = Math.max(0, bot.flash.material.opacity - dt * 14.0);
      }

      if (bot.stunTimer > 0) {
        bot.stunTimer -= dt;
        bot.group.rotation.z = Math.sin(elapsed * 14.0) * 0.18;
        continue;
      }

      // Тактичний рух між укриттями (Strafe & Advance)
      bot.peekPhase += dt * 1.9;
      bot.advancePhase += dt * 0.85;
      const targetX = THREE.MathUtils.lerp(bot.baseX, bot.patrolX, (Math.sin(bot.peekPhase) + 1) * 0.5);
      const targetZ = bot.baseZ + Math.sin(bot.advancePhase) * 2.6 * (bot.isAlly ? -1 : 1);

      bot.group.position.x = THREE.MathUtils.lerp(bot.group.position.x, targetX, dt * 3.0);
      bot.group.position.z = THREE.MathUtils.lerp(bot.group.position.z, targetZ, dt * 1.8);
      bot.group.rotation.z = (bot.group.position.x - bot.baseX) * -0.15;

      // Пошук найближчої ворожої цілі для бота
      let bestTargetPos = null;
      let bestTargetBot = null;
      let minDist = 28.0;

      if (bot.isAlly) {
        // Союзник SWAT шукає живих ворогів OPFOR
        for (const other of this.bots) {
          if (other.alive && !other.isAlly) {
            const d = bot.group.position.distanceTo(other.group.position);
            if (d < minDist) {
              minDist = d;
              bestTargetPos = other.group.position.clone().add(new THREE.Vector3(0, 1.3, 0));
              bestTargetBot = other;
            }
          }
        }
      } else {
        // Ворог OPFOR обирає найближчу ціль між гравцем та союзниками SWAT
        if (!this.isDead) {
          const dPlayer = bot.group.position.distanceTo(this.playerPos);
          if (dPlayer < minDist) {
            minDist = dPlayer;
            bestTargetPos = this.playerPos.clone();
            bestTargetBot = 'player';
          }
        }
        for (const other of this.bots) {
          if (other.alive && other.isAlly) {
            const d = bot.group.position.distanceTo(other.group.position);
            if (d < minDist) {
              minDist = d;
              bestTargetPos = other.group.position.clone().add(new THREE.Vector3(0, 1.3, 0));
              bestTargetBot = other;
            }
          }
        }
      }

      // Живі саккадичні мікрорухи очей та напруга брів під час контакту з ворогом
      if (bot.eyePair) {
        bot.eyePair.rotation.y = Math.sin(elapsed * 4.7 + bot.peekPhase) * 0.08;
        bot.eyePair.rotation.x = Math.cos(elapsed * 3.3 + bot.advancePhase) * 0.05;
      }

      if (bestTargetPos) {
        const toTarget = bestTargetPos.clone().sub(bot.group.position);
        bot.group.rotation.y = Math.atan2(toTarget.x, toTarget.z);

        const eyePos = bot.group.position.clone().add(new THREE.Vector3(0, 1.45, 0));
        const dir = bestTargetPos.clone().sub(eyePos).normalize();
        this.raycaster.set(eyePos, dir);
        const wallHits = this.raycaster.intersectObjects(wallMeshes, false);
        const hasLOS = wallHits.length === 0 || wallHits[0].distance > minDist;

        if (bot.leftBrow && bot.rightBrow) {
          const browAngle = hasLOS ? 0.19 : 0.08;
          bot.leftBrow.rotation.z = -browAngle;
          bot.rightBrow.rotation.z = browAngle;
        }

        if (hasLOS) {
          bot.fireCooldown -= dt;
          if (bot.fireCooldown <= 0) {
            bot.fireCooldown = 0.75 + Math.random() * 0.75;
            bot.flash.material.opacity = 1.0;
            this.audio.playGunshot(false, bot.group.position.distanceTo(this.playerPos));

            if (bestTargetBot === 'player') {
              const leanProtection = Math.abs(this.leanCurrent) > 0.4 ? 0.45 : 1.0;
              const hitChance = THREE.MathUtils.clamp((13.0 / Math.max(minDist, 4.0)) * 0.22 * leanProtection, 0.06, 0.42);
              if (Math.random() < hitChance) {
                this.onPlayerHit();
              }
            } else if (bestTargetBot && Math.random() < 0.36) {
              bestTargetBot.hp -= 1;
              if (bestTargetBot.hp <= 0) {
                this.onBotKilled(bestTargetBot, 'bot');
              }
            }
          }
        }
      }
    }
  }

  updateAxonTimestamp() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const ms = pad(Math.floor(now.getMilliseconds() / 10), 2);
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms} +0300`;
    const el = document.getElementById('axon-timestamp');
    if (el) el.textContent = stamp;
  }

  animate(nowMs = performance.now()) {
    requestAnimationFrame(this.animate);

    // Якщо вибрано режим для телефона — автоматично обмежуємо частоту кадрів екрана до 60 Гц (16.67 мс)
    if (this.lock60Hz) {
      const deltaMs = nowMs - this.lastRenderTimeMs;
      if (deltaMs < this.targetFrameIntervalMs - 0.45) {
        return;
      }
      this.lastRenderTimeMs = nowMs - (deltaMs % this.targetFrameIntervalMs);
    } else {
      this.lastRenderTimeMs = nowMs;
    }

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.getElapsedTime();

    // Підрахунок реальної частоти Гц / FPS для OSD-штампа камери та мобільної панелі
    this.fpsCounterFrames++;
    this.fpsCounterAccum += dt;
    if (this.fpsCounterAccum >= 0.5) {
      const rawHz = Math.round(this.fpsCounterFrames / this.fpsCounterAccum);
      this.measuredHz = this.lock60Hz ? Math.min(60, rawHz || 60) : (rawHz || 60);
      this.fpsCounterFrames = 0;
      this.fpsCounterAccum = 0;

      const hzLabel = document.getElementById('axon-hz-label');
      if (hzLabel) {
        hzLabel.textContent = this.lock60Hz
          ? `DISPLAY: 60Hz LOCK (${this.measuredHz} FPS)`
          : `DISPLAY: ${this.measuredHz}Hz`;
      }
      const phoneHzPill = document.getElementById('phone-hz-pill');
      if (phoneHzPill && this.lock60Hz) {
        phoneHzPill.textContent = `⚡ ЕКРАН: 60 ГЦ (${this.measuredHz} FPS)`;
      }
    }

    this.updateAxonTimestamp();

    if (this.isRunning && !this.opticsMenuOpen) {
      this.pollGamepadAndJoystick(dt);
      this.updateMapRotationTimer(dt);
      this.updatePlayerMovement(dt);
      this.updateAIAndGrenades(dt, elapsed);
      this.updateAutoExposure(dt);
    } else {
      this.cameraRig.position.set(Math.sin(elapsed * 0.35) * 0.35, this.chestHeight, 13.5);
      this.cameraRig.rotation.set(Math.sin(elapsed * 0.5) * 0.03, Math.sin(elapsed * 0.25) * 0.14, Math.cos(elapsed * 0.4) * 0.02);
    }

    // Оновлення біофізики шкіри (BSSRDF, себум, динамічний кровотік) та очей (зіниці від світла й адреналіну, вени склери)
    if (this.env.shaderFactory) {
      const currentMapDef = this.env.mapDefinitions[this.env.currentMapIndex];
      this.env.shaderFactory.updateBiophysics(dt, elapsed, {
        combatStress: this.combatStressLevel ?? 0.25,
        sceneLuma: this.adaptedLuma,
        concussion: this.concussionAmount,
        isNight: Boolean(currentMapDef && currentMapDef.isNight)
      });
    }

    this.env.update(dt, this.playerPos);

    this.damagePulse = Math.max(0, this.damagePulse - dt * 0.85);
    this.concussionAmount = Math.max(0, this.concussionAmount - dt * 0.22);
    this.postProcessor.uniforms.uDamagePulse.value = this.damagePulse;
    this.postProcessor.uniforms.uConcussion.value = this.concussionAmount;
    this.postProcessor.uniforms.uSignalGlitch.value = Math.max(0, this.postProcessor.uniforms.uSignalGlitch.value - dt * 2.4);

    this.postProcessor.uniforms.uMotionBlur.value.lerp(this.mouseDelta, 0.35);
    this.mouseDelta.multiplyScalar(0.5);

    this.postProcessor.render(this.scene, this.camera, dt, elapsed);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.bodycamSim = new BodycamSimulator();
});
