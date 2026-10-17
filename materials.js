import * as THREE from 'three';

/**
 * Модуль ультрареалістичної біофізики персонажів та колоїдних рідин (рівень Unreal Engine 5 / MetaHuman):
 * 1. Трьохшарова біофізика шкіри:
 *    - Ліпідна плівка (Себум / Шкірний жир + Піт): F0 Френеля та жирний блиск на носі й лобі
 *    - Епідерміс (Шар меланіну): спектральне поглинання світла меланіном
 *    - Дерма (Шар капілярів і колагену): глибоке розсіювання в гемоглобіні крові
 * 2. Математична модель BSSRDF (Bidirectional Scattering-Surface Reflectance Distribution Function):
 *    - Підповерхнева дифузія світла на 2–5 мм між точкою входу А та точкою виходу Б з урахуванням кривизни геометрії,
 *      що розмиває різкі тіні теплим червонуватим градієнтом
 * 3. Шейдер динамічного кровотоку (Dynamic Blood Flow):
 *    - У реальному часі витісняє кров у зонах натягу м'язів/суглобів (шкіра біліє) та розширює капіляри
 *      на щоках, носі й лобі під дією адреналіну, злості та пульсу серця
 * 4. Шейдер пушку на обличчі (Peach Fuzz / Vellus Hair):
 *    - Тисячі мікроскопічних напівпрозорих волосинок, що ловлять контрове світло й створюють золотистий ореол
 * 5. Шейдер волосся та брів: Модель Маршнера (Marschner Hair Model — шляхи R, TT, TRT):
 *    - Кератинові циліндри з лусочками кутикули: первинний білий блік (R), золотисто-мідне світіння наскрізь (TT)
 *      та глибоке внутрішнє подвійне відбиття (TRT)
 * 6. Очі з реакцією на стрес, адреналін і світло:
 *    - Динамічне розширення/звуження зіниці від світла й переляку (адреналіну), сітка червоних капілярів склери,
 *      заломлююча рогівка та вологе слізне озерце (Lacrimal Caruncle) у куточках очей
 * 7. Тактична тканина Cordura (Cloth Fuzz/Sheen), балістичні окуляри (Thin Translucent) та колоїдна кров (DBuffer + Коагуляція)
 */
export class TacticalShadersFactory {
  constructor() {
    // Глобальні біофізичні параметри, що оновлюються щокадру залежно від стресу, освітлення та пульсу
    this.sweatUniform = { value: 0.25 };       // Рівень поту та себуму (0..1)
    this.adrenalineUniform = { value: 0.22 };  // Адреналін / бойовий стрес (0..1)
    this.bloodFlowUniform = { value: 0.0 };    // Фаза серцебиття та припливу крові в дермі
    this.pupilSizeUniform = { value: 0.42 };   // Динамічний радіус зіниці (реакція на світло + адреналін)
    this.scleraVeinUniform = { value: 0.35 };  // Яскравість капілярної сітки склери (втома / дим / контузія)

    this.skinMicroNormal = this.generateSkinMicroNormalMap();
    this.sweatRoughnessMap = this.generateSweatRoughnessMap();
    this.bloodTensionMap = this.generateBloodFlowTensionMap();
    this.corduraNormalMap = this.generateCorduraWeaveMap();
    this.visorScratchMap = this.generateVisorScratchMap();
  }

  /**
   * Оновлення біофізичних уніформ щокадру (пульсація кровотоку, розширення зіниць від темряви й адреналіну, почервоніння склери)
   */
  updateBiophysics(dt, elapsed, { combatStress = 0.25, sceneLuma = 0.45, concussion = 0.0, isNight = false } = {}) {
    this.sweatUniform.value = THREE.MathUtils.clamp(combatStress * 0.85 + concussion * 0.4, 0.15, 1.0);
    this.adrenalineUniform.value = THREE.MathUtils.clamp(combatStress + concussion * 0.7, 0.1, 1.0);

    // Пульсація серця (прискорюється від адреналіну з 75 до 155 ударів/хв)
    const heartRateHz = 1.25 + this.adrenalineUniform.value * 1.35;
    this.bloodFlowUniform.value = elapsed * heartRateHz * Math.PI * 2.0;

    // Зіниця звужується на яскравому сонці, але миттєво розширюється у темряві та під час викиду адреналіну/переляку
    const lightOpening = isNight ? 0.68 : THREE.MathUtils.clamp(0.62 - sceneLuma * 0.36, 0.22, 0.68);
    const adrenalineDilation = this.adrenalineUniform.value * 0.24 + concussion * 0.22;
    const targetPupil = THREE.MathUtils.clamp(lightOpening + adrenalineDilation, 0.20, 0.82);
    this.pupilSizeUniform.value = THREE.MathUtils.lerp(this.pupilSizeUniform.value, targetPupil, dt * 6.5);

    // Сітка червоних вен на склері ока стає яскравішою від втоми, диму та світлошумової контузії
    const targetVeins = THREE.MathUtils.clamp(0.28 + combatStress * 0.48 + concussion * 0.65, 0.22, 1.0);
    this.scleraVeinUniform.value = THREE.MathUtils.lerp(this.scleraVeinUniform.value, targetVeins, dt * 3.0);
  }

  /**
   * 1A. Карта мікропор шкіри (Micro-Normal Map: пори, борозенки епідермісу, фолікули пушку Vellus Hair)
   */
  generateSkinMicroNormalMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, 256, 256);

    // Мікроскопічні пори шкіри та перехресні лінії епідермісу
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const nx = 102 + Math.floor(Math.random() * 52);
      const ny = 102 + Math.floor(Math.random() * 52);
      ctx.fillStyle = `rgb(${nx}, ${ny}, 244)`;
      ctx.fillRect(x, y, 2, 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    return tex;
  }

  /**
   * 1B. Маска ліпідної плівки (Себум / Шкірний жир) та вологи поту:
   * Т-зона (лоб, спинка носа, під очима) має підвищену концентрацію шкірного сала (Sebum)
   */
  generateSweatRoughnessMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgb(142, 142, 142)';
    ctx.fillRect(0, 0, 256, 256);

    // Ліпідна Т-зона (себум на лобі, носі та щоках) — жирний блиск Френеля
    const grad = ctx.createRadialGradient(128, 96, 12, 128, 128, 118);
    grad.addColorStop(0, 'rgb(14, 14, 14)');   // Дзеркальний себум + краплі поту
    grad.addColorStop(0.52, 'rgb(48, 48, 48)');
    grad.addColorStop(1, 'rgb(142, 142, 142)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = 'rgb(6, 6, 6)';
      ctx.beginPath();
      ctx.arc(Math.random() * 256, Math.random() * 256, 1.4 + Math.random() * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /**
   * 1C. Карта судинних зон та м'язового натягу для динамічного кровотоку (Dynamic Blood Flow Map):
   * R-канал: щільність капілярів у дермі (щоки, кінчик носа, вуха, лоб)
   * G-канал: зони механічного натягу сухожиль/кісточок (де кров витісняється при напрузі й шкіра біліє)
   */
  generateBloodFlowTensionMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Базова дерма
    ctx.fillStyle = 'rgb(135, 90, 128)';
    ctx.fillRect(0, 0, 256, 256);

    // Капілярні зони припливу крові (щоки, ніс, вуха — високий R)
    const capGrad = ctx.createRadialGradient(128, 132, 14, 128, 132, 96);
    capGrad.addColorStop(0, 'rgba(255, 30, 128, 0.85)');
    capGrad.addColorStop(0.6, 'rgba(210, 60, 128, 0.45)');
    capGrad.addColorStop(1, 'rgba(120, 140, 128, 0.0)');
    ctx.fillStyle = capGrad;
    ctx.fillRect(0, 0, 256, 256);

    // Зони натягу м'язів / кісточок пальців (високий G — шкіра блідне при стисканні)
    ctx.fillStyle = 'rgba(40, 235, 128, 0.55)';
    ctx.fillRect(0, 0, 256, 36);
    ctx.fillRect(0, 215, 256, 41);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /**
   * 1–4. Шейдер живої шкіри:
   * - Трьохшарова біофізика (Ліпідна плівка Себуму + Епідерміс з меланіном + Дерма з капілярами)
   * - Математична модель BSSRDF (підповерхнева дифузія світла на 2–5 мм, що розмиває різкі тіні)
   * - Динамічний кровотік (Dynamic Blood Flow: збліднення при натягу м'язів та почервоніння від адреналіну)
   * - Пушок на обличчі (Peach Fuzz / Vellus Hair: золотистий м'який ореол у контровому світлі)
   */
  createSubsurfaceSkinMaterial(baseToneHex = 0xd8a384, melaninAmount = 0.24) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: baseToneHex,
      normalMap: this.skinMicroNormal,
      normalScale: new THREE.Vector2(0.42, 0.42),
      roughnessMap: this.sweatRoughnessMap,
      roughness: 0.40,
      metalness: 0.01,
      // Шар 1: Ліпідна плівка (Себум / Шкірний жир) товщиною в частки мікрона (IOR 1.49)
      clearcoat: 0.58,
      clearcoatRoughness: 0.14,
      ior: 1.44
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSweat = this.sweatUniform;
      shader.uniforms.uAdrenaline = this.adrenalineUniform;
      shader.uniforms.uBloodFlowPhase = this.bloodFlowUniform;
      shader.uniforms.uBloodTensionMap = { value: this.bloodTensionMap };
      shader.uniforms.uMelanin = { value: melaninAmount };
      shader.uniforms.uDermisBloodColor = { value: new THREE.Color(0xd91e18) };
      shader.uniforms.uPeachFuzzColor = { value: new THREE.Color(0xffe3b3) }; // Золотистий ореол пушку Vellus Hair

      shader.vertexShader = `
        varying vec3 vSkinWorldPos;
        varying vec2 vSkinUv;
      ` + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vSkinWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSkinUv = uv;
        `
      );

      shader.fragmentShader = `
        uniform float uSweat;
        uniform float uAdrenaline;
        uniform float uBloodFlowPhase;
        uniform sampler2D uBloodTensionMap;
        uniform float uMelanin;
        uniform vec3 uDermisBloodColor;
        uniform vec3 uPeachFuzzColor;
        varying vec3 vSkinWorldPos;
        varying vec2 vSkinUv;
      ` + shader.fragmentShader;

      // Ліпідна плівка (Себум + Піт): динамічний Roughness на носі, лобі та пальцях
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `
        #include <roughnessmap_fragment>
        // Коли боєць втомлюється або пітніє, ліпідна плівка себуму та вологи знижує шорсткість майже до 0
        roughnessFactor = mix(roughnessFactor, max(0.03, roughnessFactor * 0.15), clamp(uSweat, 0.0, 1.0));
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
        vec3 viewDirSkin = normalize(vViewPosition);
        float NdotV_skin = max(dot(normal, viewDirSkin), 0.0);

        // =========================================================================
        // 1. ТРЬОХШАРОВА БІОФІЗИКА ШКІРИ (Себум -> Епідерміс -> Дерма)
        //    + 3. ДИНАМІЧНИЙ КРОВОТІК (Dynamic Blood Flow)
        // =========================================================================
        vec4 vascularSample = texture2D(uBloodTensionMap, vSkinUv);
        float capillaryZone = vascularSample.r; // Щільність капілярів (щоки, ніс, вуха, лоб)
        float muscleTension = vascularSample.g; // Зона натягу м'язів та сухожиль

        // Пульсова хвиля кровотоку + розширення судин під час адреналіну/злості
        float pulseWave = 0.5 + 0.5 * sin(uBloodFlowPhase);
        float vasodilation = clamp(capillaryZone * (0.45 + uAdrenaline * 0.55 + pulseWave * 0.16), 0.0, 1.0);
        // При сильному натягу м'язів кров витісняється і шкіра світлішає/біліє
        float blanching = clamp(muscleTension * (0.35 + (1.0 - capillaryZone) * 0.45), 0.0, 0.85);

        // Шар 2 (Епідерміс): поглинання світла клітинами меланіну
        vec3 melaninAbsorption = exp(-uMelanin * vec3(0.85, 1.45, 2.35));
        // Шар 3 (Дерма): глибокий колір гемоглобіну та колагену з динамічним кровотоком
        vec3 blanchedCollagen = vec3(0.97, 0.91, 0.84);
        vec3 dynamicDermis = mix(uDermisBloodColor, blanchedCollagen, blanching * 0.55);
        outgoingLight *= mix(vec3(1.0), melaninAbsorption, 0.35);

        // =========================================================================
        // 2. МАТЕМАТИЧНА МОДЕЛЬ BSSRDF (Підповерхнева дифузія 2–5 мм між точками А і Б)
        // =========================================================================
        // Оцінюємо локальну кривизну поверхні (на носі, вухах, пальцях кривизна вища -> промінь легше проходить наскрізь)
        float skinCurvature = clamp(length(fwidth(normal)) / max(length(fwidth(vSkinWorldPos)) * 18.0, 0.001), 0.12, 1.0);
        float lightLuma = dot(outgoingLight, vec3(0.299, 0.587, 0.114));

        // BSSRDF розмиває різку межу світла й тіні (термінатор), бо червоні фотони блукають у дермі на 2–5 мм
        float terminatorZone = smoothstep(0.02, 0.38, lightLuma) * (1.0 - smoothstep(0.38, 0.82, lightLuma));
        float rimTranslucency = pow(1.0 - NdotV_skin, 2.3);
        vec3 bssrdfDiffusion = dynamicDermis * (
          terminatorZone * (0.48 + vasodilation * 0.35) * (0.65 + skinCurvature * 0.6) +
          rimTranslucency * (0.36 + vasodilation * 0.28) * skinCurvature
        );
        outgoingLight += bssrdfDiffusion;

        // Додатковий живий рум'янець у розширених капілярах дерми
        outgoingLight = mix(outgoingLight, outgoingLight * vec3(1.14, 0.86, 0.84), vasodilation * 0.42);

        // Шар 1 (Ліпідна плівка Себуму / Шкірного жиру): дзеркальний відблиск Френеля на носі й лобі
        float sebumFresnel = pow(1.0 - NdotV_skin, 4.2) * (0.22 + uSweat * 0.55);
        float sebumHotspot = pow(NdotV_skin, 34.0) * (0.14 + uSweat * 0.32) * capillaryZone;
        outgoingLight += vec3(0.98, 0.99, 1.0) * (sebumFresnel * 0.28 + sebumHotspot);

        // =========================================================================
        // 4. ШЕЙДЕР ПУШКУ НА ОБЛИЧЧІ (Peach Fuzz / Vellus Hair)
        // =========================================================================
        // Тисячі мікроскопічних напівпрозорих волосинок пушку ловлять контрове світло під кутом
        // і створюють м'який золотистий ореол навколо щік, лоба та підборіддя
        float microHairNoise = 0.82 + 0.18 * sin(vSkinUv.x * 420.0 + vSkinUv.y * 380.0);
        float peachFuzzHalo = pow(1.0 - NdotV_skin, 3.6) * smoothstep(0.04, 0.65, lightLuma + 0.15) * microHairNoise;
        outgoingLight += uPeachFuzzColor * peachFuzzHalo * 0.34;

        #include <opaque_fragment>
        `
      );
    };

    return mat;
  }

  /**
   * 5. ШЕЙДЕР ВОЛОССЯ, БРІВ ТА ВІЙ: МОДЕЛЬ МАРШНЕРА (Marschner Hair Model)
   * Кожна волосинка — напівпрозорий кератиновий циліндр із мікроскопічними лусочками кутикули.
   * Прораховує три фізичні шляхи світла:
   * - R (Primary Specular Reflection): білий відблиск від поверхні волосини (зміщений на кут лусочок -alpha)
   * - TT (Transmission-Transmission): проходження світла наскрізь (золотисто-мідне світіння проти сонця/ліхтаря)
   * - TRT (Transmission-Reflection-Transmission): внутрішнє подвійне відбиття (глибокий каштаново-мідний колір)
   */
  createMarschnerHairMaterial(baseHairHex = 0x261810) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uBaseHairColor: { value: new THREE.Color(baseHairHex) },
        uLightDir: { value: new THREE.Vector3(0.45, 0.82, 0.35).normalize() }
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vTangent;
        varying vec3 vViewDir;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormal = normalize(mat3(modelMatrix) * normal);
          // Вектор вздовж росту волосини (тангенс кератинового циліндра)
          vTangent = normalize(mat3(modelMatrix) * vec3(1.0, 0.15, 0.0));
          vViewDir = normalize(cameraPosition - worldPos.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform vec3 uBaseHairColor;
        uniform vec3 uLightDir;

        varying vec3 vNormal;
        varying vec3 vTangent;
        varying vec3 vViewDir;
        varying vec2 vUv;

        void main() {
          // Мікротекстура окремих кератинових волокон у пасмі/брові
          float strandPattern = 0.72 + 0.28 * sin(vUv.x * 160.0 + sin(vUv.y * 45.0) * 2.5);
          vec3 T = normalize(vTangent + vec3(0.0, (strandPattern - 0.85) * 0.2, 0.0));
          vec3 V = normalize(vViewDir);
          vec3 L = normalize(uLightDir);

          // Кути нахилу променя та погляду відносно осі волосини (sinThetaI, sinThetaO)
          float sinThetaI = clamp(dot(L, T), -1.0, 1.0);
          float sinThetaO = clamp(dot(V, T), -1.0, 1.0);
          float sinThetaH = sinThetaI + sinThetaO;
          float cosThetaO = sqrt(max(0.001, 1.0 - sinThetaO * sinThetaO));

          // Кут нахилу мікроскопічних лусочок кутикули кератину (alpha ~ 0.055 рад ≈ 3.1 градуса)
          float cuticleTilt = 0.055;

          // 1. Шлях R (Відбиття від поверхні волосини): чистий білий відблиск Френеля
          float shiftR = sinThetaH - 2.0 * cuticleTilt;
          float lobeR = exp(-(shiftR * shiftR) / 0.032) * cosThetaO;
          vec3 colorR = vec3(0.96, 0.97, 1.0) * lobeR * 0.42;

          // 2. Шлях TT (Проходження наскрізь): коли світло позаду або збоку, волосина світиться золотом і міддю!
          float backLightFactor = pow(max(0.0, dot(-L, V) * 0.65 + 0.35), 2.2);
          float shiftTT = sinThetaH + cuticleTilt;
          float lobeTT = exp(-(shiftTT * shiftTT) / 0.055) * backLightFactor;
          vec3 copperGoldTT = vec3(0.98, 0.56, 0.18) * lobeTT * 0.78 * strandPattern;

          // 3. Шлях TRT (Внутрішнє подвійне відбиття): глибокий насичений колір всередині зачіски/брів
          float shiftTRT = sinThetaH + 3.0 * cuticleTilt;
          float lobeTRT = exp(-(shiftTRT * shiftTRT) / 0.085) * cosThetaO;
          vec3 deepKeratinTRT = (uBaseHairColor * vec3(1.45, 0.95, 0.72)) * lobeTRT * 0.65;

          vec3 baseDiffuse = uBaseHairColor * strandPattern * (0.45 + 0.55 * max(dot(vNormal, L), 0.2));
          vec3 finalHairColor = baseDiffuse + colorR + copperGoldTT + deepKeratinTRT;

          gl_FragColor = vec4(finalHairColor, 1.0);
        }
      `
    });
  }

  /**
   * 6. ОЧІ З РЕАКЦІЄЮ НА СТРЕС, АДРЕНАЛІН І СВІТЛО:
   * - Зіниці динамічно розширюються від адреналіну/переляку або темряви та звужуються на світлі (uPupilSize)
   * - Склера має процедурну сітку крихітних червоних вен, що стає яскравішою від втоми й контузії (uScleraVeins)
   * - Рогівка з фізичним заломленням світла (Cornea Refraction) + заглиблена волокниста райдужка
   * - Слізне озерце (Lacrimal Caruncle) у куточках очей + дзеркальна слізна плівка, що створює «іскру» в погляді
   */
  createDynamicEyeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uPupilSize: this.pupilSizeUniform,
        uScleraVeins: this.scleraVeinUniform,
        uIrisColorInner: { value: new THREE.Color(0x6e522b) }, // Бурштиново-зелений центр райдужки
        uIrisColorOuter: { value: new THREE.Color(0x2d4c3e) }  // Глибокий сіро-зелений край райдужки
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vViewDir;

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - worldPos.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform float uPupilSize;
        uniform float uScleraVeins;
        uniform vec3 uIrisColorInner;
        uniform vec3 uIrisColorOuter;

        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vViewDir;

        float hash2(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          // Центруємо координати по полюсу рогівки
          vec2 p = (vUv - vec2(0.5, 0.5)) * 2.0;

          // Фізичне заломлення рогівки (Cornea IOR = 1.38): зміщуємо внутрішню райдужку залежно від кута погляду
          vec2 refractOffset = vViewDir.xy * 0.045;
          vec2 pRefract = p - refractOffset;
          float r = length(pRefract);
          float angle = atan(pRefract.y, pRefract.x);

          // 1. СКЛЕРА (Білок ока) з розгалуженою сіткою крихітних червоних капілярів
          vec3 scleraBase = vec3(0.92, 0.89, 0.87);
          float veinBranch1 = abs(sin(angle * 14.0 + r * 9.0 + sin(r * 22.0) * 0.8));
          float veinBranch2 = abs(cos(angle * 23.0 - r * 13.0));
          float veinMask = (smoothstep(0.09, 0.0, veinBranch1) * 0.75 + smoothstep(0.07, 0.0, veinBranch2) * 0.45)
                         * smoothstep(0.42, 0.68, r);
          vec3 bloodVeinColor = vec3(0.76, 0.09, 0.11);
          vec3 scleraCol = mix(scleraBase, bloodVeinColor, clamp(veinMask * uScleraVeins, 0.0, 0.88));

          // 2. ЗАГЛИБЛЕНА РАЙДУЖКА (Iris) зі складною текстурою радіальних волокон строми
          float irisRadius = 0.44;
          float pupilRadius = clamp(uPupilSize * 0.28, 0.07, 0.26); // Реакція зіниці на світло та адреналін!
          float irisNormR = clamp((r - pupilRadius) / max(irisRadius - pupilRadius, 0.001), 0.0, 1.0);

          float fibers = 0.65 + 0.35 * sin(angle * 64.0 + sin(irisNormR * 12.0) * 1.6)
                       * cos(angle * 28.0 - irisNormR * 6.0);
          vec3 irisCol = mix(uIrisColorInner, uIrisColorOuter, smoothstep(0.15, 0.88, irisNormR)) * (0.75 + 0.45 * fibers);
          // Темне лімбальне кільце по зовнішньому контуру райдужки
          irisCol *= (1.0 - smoothstep(0.78, 1.0, irisNormR) * 0.62);

          // 3. ЗІНИЦЯ (Pupil)
          vec3 eyeInterior = scleraCol;
          if (r < irisRadius) {
            eyeInterior = mix(irisCol, scleraCol, smoothstep(irisRadius - 0.025, irisRadius, r));
          }
          if (r < pupilRadius) {
            eyeInterior = mix(vec3(0.015, 0.018, 0.022), eyeInterior, smoothstep(pupilRadius - 0.018, pupilRadius, r));
          }

          // 4. РОГІВКА ТА ІСКРА В ПОГЛЯДІ (Вологий дзеркальний блік рогівки та Френель)
          vec3 N = normalize(vNormal);
          vec3 V = normalize(vViewDir);
          vec3 L = normalize(vec3(0.35, 0.65, 0.75));
          vec3 H = normalize(L + V);
          float corneaSpec = pow(max(dot(N, H), 0.0), 220.0) * 1.45;
          float corneaFresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.25;

          vec3 finalEye = eyeInterior + vec3(1.0, 0.99, 0.97) * (corneaSpec + corneaFresnel);
          gl_FragColor = vec4(finalEye, 1.0);
        }
      `
    });
  }

  createRealisticEyePair() {
    const eyeGroup = new THREE.Group();

    const dynamicEyeballMat = this.createDynamicEyeMaterial();

    // Слізна плівка (Tear Film Meniscus) на стику нижньої повіки та очного яблука
    const tearFilmMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.0,
      metalness: 0.08,
      transmission: 0.88,
      transparent: true,
      opacity: 0.78,
      clearcoat: 1.0
    });

    // Слізне озерце (Lacrimal Caruncle) — мікроскопічна волога в куточках очей, що заломлює світ і створює «іскру»
    const lacrimalCaruncleMat = new THREE.MeshPhysicalMaterial({
      color: 0xd96b70,
      roughness: 0.02,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.0,
      ior: 1.42,
      reflectivity: 1.0
    });

    for (const side of [-1, 1]) {
      const eyeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.032, 18, 18), dynamicEyeballMat);
      eyeMesh.rotation.y = -Math.PI / 2;
      eyeMesh.position.set(side * 0.056, 0, 0);
      eyeGroup.add(eyeMesh);

      // Слізна плівка вздовж нижньої повіки
      const tearStrip = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.006, 0.012), tearFilmMat);
      tearStrip.position.set(side * 0.056, -0.022, 0.026);
      eyeGroup.add(tearStrip);

      // Слізне озерце у внутрішньому куточку кожного ока (ближче до перенісся)
      const lacrimalPool = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 8), lacrimalCaruncleMat);
      lacrimalPool.position.set(side * 0.031, -0.005, 0.027);
      eyeGroup.add(lacrimalPool);
    }

    return eyeGroup;
  }

  /**
   * 7. Шейдер тактичної тканини та камуфляжу: Cloth Shading Model (Cordura / Camo Fuzz & Sheen)
   */
  generateCorduraWeaveMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, 256, 256);

    for (let y = 0; y < 256; y += 4) {
      for (let x = 0; x < 256; x += 4) {
        const isWarp = ((x + y) % 8 === 0);
        ctx.fillStyle = isWarp ? 'rgb(148, 112, 245)' : 'rgb(108, 144, 245)';
        ctx.fillRect(x, y, 3, 3);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 12);
    return tex;
  }

  createTacticalClothMaterial(optionsOrHex = 0x2b322c, fuzzColorHex = 0x8a968c) {
    let baseColor = 0x2b322c;
    let sheenColor = fuzzColorHex;
    let roughness = 0.88;

    if (typeof optionsOrHex === 'object' && optionsOrHex !== null) {
      baseColor = optionsOrHex.baseColor ?? 0x2b322c;
      sheenColor = optionsOrHex.sheenColor ?? 0x8a968c;
      roughness = optionsOrHex.roughness ?? 0.88;
    } else {
      baseColor = optionsOrHex;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      normalMap: this.corduraNormalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness,
      metalness: 0.02
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFuzzColor = { value: new THREE.Color(sheenColor) };
      shader.fragmentShader = `
        uniform vec3 uFuzzColor;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
        vec3 viewDirCloth = normalize(vViewPosition);
        float clothFuzz = pow(1.0 - max(dot(normal, viewDirCloth), 0.0), 3.1);
        outgoingLight += uFuzzColor * clothFuzz * 0.28;
        #include <opaque_fragment>
        `
      );
    };

    return mat;
  }

  /**
   * 8. Шейдер балістичних окулярів та забрал шоломів (Thin Translucent Ballistic Polycarbonate)
   */
  generateVisorScratchMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgb(30, 30, 30)';
    ctx.fillRect(0, 0, 256, 128);

    ctx.strokeStyle = 'rgb(210, 210, 210)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 28; i++) {
      ctx.beginPath();
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 35, y + (Math.random() - 0.5) * 18);
      ctx.stroke();
    }
    for (let d = 0; d < 220; d++) {
      ctx.fillStyle = 'rgb(180, 180, 180)';
      ctx.fillRect(Math.random() * 256, Math.random() * 128, 1.5, 1.5);
    }

    return new THREE.CanvasTexture(canvas);
  }

  createBallisticVisorMaterial(optionsOrBool = true) {
    let tintColor = 0xffd43b;
    let opacity = 0.36;

    if (typeof optionsOrBool === 'object' && optionsOrBool !== null) {
      tintColor = optionsOrBool.tintColor ?? 0xffd43b;
      opacity = tintColor === 0xffe066 ? 0.34 : 0.44;
    } else {
      tintColor = optionsOrBool ? 0xffd43b : 0x1e293b;
      opacity = optionsOrBool ? 0.36 : 0.48;
    }

    return new THREE.MeshPhysicalMaterial({
      color: tintColor,
      roughnessMap: this.visorScratchMap,
      bumpMap: this.visorScratchMap,
      bumpScale: 0.004,
      roughness: 0.08,
      metalness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      ior: 1.58,
      transparent: true,
      opacity,
      side: THREE.DoubleSide
    });
  }

  /**
   * 9. Оптичний шейдер колоїдної крові (DBuffer Decal + Поверхневий натяг + SSS + Коагуляція за 10–30 с)
   */
  createColloidalBloodDecalMaterial(seed = Math.random() * 100) {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      uniforms: {
        uAge: { value: 0.0 },
        uSeed: { value: seed },
        uLightPos: { value: new THREE.Vector3(6, 12, 8) }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;

        void main() {
          vUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPosition.xyz;
          vViewDir = normalize(cameraPosition - worldPosition.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform float uAge;
        uniform float uSeed;
        uniform vec3 uLightPos;

        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vViewDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        void main() {
          vec2 pUv = (vUv - 0.5) * 2.0 + vViewDir.xy * 0.035;
          float r = length(pUv);
          float angle = atan(pUv.y, pUv.x);

          float splatterShape = noise(vec2(angle * 3.5 + uSeed, r * 4.0)) * 0.34
                              + noise(pUv * 6.5 + uSeed) * 0.18;

          float coagulation = smoothstep(4.0, 22.0, uAge);
          float effectiveRadius = (0.78 - coagulation * 0.06) + splatterShape;

          float thickness = clamp((effectiveRadius - r) * 3.2, 0.0, 1.0);
          if (thickness <= 0.01) discard;

          float rimBand = smoothstep(0.05, 0.35, thickness) * (1.0 - smoothstep(0.35, 0.75, thickness));
          vec3 liquidNormal = normalize(vec3(
            -pUv.x * (rimBand * 2.2 + 0.25),
            1.0,
            -pUv.y * (rimBand * 2.2 + 0.25)
          ));

          vec3 centerVenous = vec3(0.11, 0.006, 0.010);
          vec3 edgeRubySSS = vec3(0.86, 0.035, 0.065);
          vec3 freshBloodCol = mix(edgeRubySSS, centerVenous, smoothstep(0.12, 0.68, thickness));

          vec3 driedCrustCol = vec3(0.13, 0.032, 0.018) * (0.75 + 0.25 * noise(pUv * 14.0));
          vec3 baseCol = mix(freshBloodCol, driedCrustCol, coagulation);

          vec3 lightDir = normalize(uLightPos - vWorldPos);
          vec3 halfVec = normalize(lightDir + vViewDir);
          float NdotH = max(dot(liquidNormal, halfVec), 0.0);

          float specPower = mix(160.0, 8.0, coagulation);
          float specStrength = mix(0.95, 0.04, coagulation);
          float specular = pow(NdotH, specPower) * specStrength;

          float fresnelRim = pow(1.0 - max(dot(liquidNormal, vViewDir), 0.0), 3.0) * (1.0 - coagulation) * 0.38;

          vec3 finalColor = baseCol + vec3(1.0, 0.96, 0.94) * (specular + fresnelRim);
          float alpha = smoothstep(0.0, 0.14, thickness);

          gl_FragColor = vec4(finalColor, alpha * 0.96);
        }
      `
    });
  }
}
