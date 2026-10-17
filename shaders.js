import * as THREE from 'three';

/**
 * Повноекранний GLSL-пайплайн оптики нагрудної камери AXON BODY 3 / GoPro:
 * - Barrel Distortion (Fisheye) із фізичним корпусом об'єктива по кутах
 * - Радіальна хроматична аберація по краях лінзи
 * - Інерційна автоекспозиція сенсора
 * - Двотрубні окуляри нічного бачення AN/PVS-31 (Green/White Phosphor NVG)
 * - КРОВ НА СКЛІ НАГРУДНОЇ КАМЕРИ (Lens Blood): фізичне заломлення світла (Refraction)
 *   крізь краплі, рубіновий SSS по краях та повільне стікання крапель донизу під дією гравітації!
 */
export class BodycamPostProcessor {
  constructor(renderer) {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    this.renderTarget = new THREE.WebGLRenderTarget(
      Math.floor(size.x * pixelRatio),
      Math.floor(size.y * pixelRatio),
      {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: true
      }
    );

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Масив до 8 фізичних крапель крові на об'єктиві камери: vec4(x, y, radius, streakLen)
    this.maxLensDrops = 8;
    this.lensDropsState = [];
    const initialDropsUniform = [];
    for (let i = 0; i < this.maxLensDrops; i++) {
      initialDropsUniform.push(new THREE.Vector4(-10, -10, 0, 0));
    }

    this.uniforms = {
      tDiffuse: { value: this.renderTarget.texture },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(size.x * pixelRatio, size.y * pixelRatio) },
      uFisheye: { value: 0.34 },
      uChroma: { value: 1.35 },
      uGrain: { value: 0.22 },
      uExposure: { value: 1.15 },
      uOverexposureFlash: { value: 0.0 },
      uMotionBlur: { value: new THREE.Vector2(0, 0) },
      uConcussion: { value: 0.0 },
      uDamagePulse: { value: 0.0 },
      uSignalGlitch: { value: 0.0 },
      uNvgActive: { value: 0.0 },
      uNvgWarmup: { value: 0.0 },
      uLensDrops: { value: initialDropsUniform },
      uLensDropsAlpha: { value: new Float32Array(this.maxLensDrops) }
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform float uFisheye;
        uniform float uChroma;
        uniform float uGrain;
        uniform float uExposure;
        uniform float uOverexposureFlash;
        uniform vec2 uMotionBlur;
        uniform float uConcussion;
        uniform float uDamagePulse;
        uniform float uSignalGlitch;
        uniform float uNvgActive;
        uniform float uNvgWarmup;
        uniform vec4 uLensDrops[8];
        uniform float uLensDropsAlpha[8];

        varying vec2 vUv;

        float hash12(vec2 p) {
          vec3 p3  = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        // Бочкоподібна дисторсія об'єктива «Риб'яче око» (Axon / GoPro Wide)
        vec2 barrelDistort(vec2 uv, float k1, float k2, float zoomComp) {
          vec2 p = (uv - 0.5) * 2.0;
          float aspect = uResolution.x / max(uResolution.y, 1.0);
          vec2 pAspect = vec2(p.x * aspect, p.y);
          float r2 = dot(pAspect, pAspect) * 0.36;
          float radial = 1.0 + k1 * r2 + k2 * r2 * r2;
          vec2 distorted = p * radial * zoomComp;
          return distorted * 0.5 + 0.5;
        }

        void main() {
          vec2 baseUv = vUv;
          if (uSignalGlitch > 0.001) {
            float blockY = floor(baseUv.y * 42.0);
            float lineNoise = hash12(vec2(blockY, floor(uTime * 24.0))) - 0.5;
            if (abs(lineNoise) > 0.34) {
              baseUv.x += lineNoise * 0.055 * uSignalGlitch;
            }
          }

          float aspect = uResolution.x / max(uResolution.y, 1.0);

          // === СПЕЦЕФЕКТ 5: КРОВ НА СКЛІ НАГРУДНОЇ КАМЕРИ (Lens Blood Refraction & Dripping) ===
          float bloodThickness = 0.0;
          vec2 bloodRefractOffset = vec2(0.0);

          for (int i = 0; i < 8; i++) {
            float dropAlpha = uLensDropsAlpha[i];
            if (dropAlpha > 0.01) {
              vec4 drop = uLensDrops[i]; // xy = позиція краплі, z = радіус, w = довжина сліду стікання зверху
              vec2 dVec = baseUv - drop.xy;
              dVec.x *= aspect;

              // Головна опукла крапля, що сповзає донизу
              float distHead = length(dVec) / max(drop.z, 0.001);
              if (distHead < 1.0) {
                float h = sqrt(max(0.0, 1.0 - distHead * distHead)) * dropAlpha;
                bloodThickness = max(bloodThickness, h);
                bloodRefractOffset += (dVec / max(drop.z, 0.001)) * h * 0.042;
              }

              // Напівпрозорий слід стікання за краплею під дією гравітації (вгору від поточної позиції)
              if (dVec.y > 0.0 && dVec.y < drop.w) {
                float trailWidth = drop.z * mix(0.68, 0.18, dVec.y / max(drop.w, 0.001));
                float distTrail = abs(dVec.x) / max(trailWidth, 0.001);
                if (distTrail < 1.0) {
                  float th = (1.0 - distTrail * distTrail) * 0.52 * dropAlpha * (1.0 - (dVec.y / drop.w) * 0.6);
                  bloodThickness = max(bloodThickness, th);
                  bloodRefractOffset.x += (dVec.x / max(trailWidth, 0.001)) * th * 0.024;
                }
              }
            }
          }

          float k1 = uFisheye;
          float k2 = uFisheye * 0.65;
          float zoomComp = 1.0 / (1.0 + k1 * 0.42);

          vec2 centered = (baseUv - 0.5) * 2.0;
          float r2 = dot(centered, centered);

          // Радіальна хроматична аберація + фізичне заломлення променів крізь краплі крові на склі!
          float chromaShift = (0.0022 + r2 * 0.008) * uChroma + uConcussion * 0.012;
          vec2 refractedUv = baseUv - bloodRefractOffset;

          vec2 uvR = barrelDistort(refractedUv, k1 + chromaShift, k2, zoomComp);
          vec2 uvG = barrelDistort(refractedUv, k1, k2, zoomComp);
          vec2 uvB = barrelDistort(refractedUv, k1 - chromaShift, k2, zoomComp);

          if (uvG.x < 0.0 || uvG.x > 1.0 || uvG.y < 0.0 || uvG.y > 1.0) {
            gl_FragColor = vec4(0.01, 0.01, 0.012, 1.0);
            return;
          }

          vec2 smear = uMotionBlur * 0.013;
          float r0 = texture2D(tDiffuse, clamp(uvR, 0.001, 0.999)).r;
          float g0 = texture2D(tDiffuse, clamp(uvG, 0.001, 0.999)).g;
          float b0 = texture2D(tDiffuse, clamp(uvB, 0.001, 0.999)).b;

          float r1 = texture2D(tDiffuse, clamp(uvR + smear, 0.001, 0.999)).r;
          float g1 = texture2D(tDiffuse, clamp(uvG + smear * 0.85, 0.001, 0.999)).g;
          float b1 = texture2D(tDiffuse, clamp(uvB - smear * 0.75, 0.001, 0.999)).b;

          vec3 col = mix(vec3(r0, g0, b0), vec3(r1, g1, b1), 0.38);

          if (uConcussion > 0.01) {
            vec2 ghostOffset = vec2(sin(uTime * 9.0), cos(uTime * 7.5)) * 0.018 * uConcussion;
            vec3 ghost = texture2D(tDiffuse, clamp(uvG + ghostOffset, 0.001, 0.999)).rgb;
            col = mix(col, ghost, 0.45 * clamp(uConcussion, 0.0, 1.0));
          }

          col *= uExposure;
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          float highlightClip = smoothstep(0.75, 1.45, luma);
          col += vec3(1.0, 0.98, 0.92) * highlightClip * (0.28 + uOverexposureFlash * 0.85);
          col = mix(col, vec3(1.0, 0.99, 0.95), clamp(uOverexposureFlash * 0.78, 0.0, 0.94));

          // === НАКЛАДАННЯ ОПТИЧНОГО ПОГЛИНАННЯ ТА SSS КРАПЕЛЬ КРОВІ НА ОБ'ЄКТИВІ ===
          if (bloodThickness > 0.01) {
            // У тонкому шарі та по краях краплі світло просвічує її рубіново-червоним (SSS),
            // а в товстому центрі крапля майже чорно-бордова з яскравим вологим бліком зверху
            vec3 rubySSS = vec3(0.88, 0.03, 0.06);
            vec3 darkIronVenous = vec3(0.12, 0.005, 0.010);
            vec3 bloodTint = mix(rubySSS, darkIronVenous, smoothstep(0.22, 0.82, bloodThickness));
            col = mix(col, col * bloodTint + rubySSS * 0.18 * (1.0 - bloodThickness), clamp(bloodThickness * 1.15, 0.0, 0.94));

            // Мокрий відблиск на опуклому бортику краплі на лінзі (Roughness ≈ 0.05)
            float meniscusSpec = smoothstep(0.18, 0.32, bloodThickness) * (1.0 - smoothstep(0.32, 0.48, bloodThickness));
            col += vec3(1.0, 0.92, 0.92) * meniscusSpec * 0.35;
          }

          // === РЕЖИМ ОКУЛЯРІВ НІЧНОГО БАЧЕННЯ AN/PVS-31 (Клавіша [N]) ===
          if (uNvgActive > 0.5) {
            vec2 pTube = vec2(centered.x * aspect, centered.y);

            float dLeft = length(pTube - vec2(-0.38, 0.0));
            float dRight = length(pTube - vec2(0.38, 0.0));
            float tubeDist = min(dLeft, dRight);

            float nvgLuma = dot(col, vec3(0.25, 0.65, 0.10));
            float amplified = pow(clamp(nvgLuma * 2.85 + 0.14, 0.0, 1.9), 0.58);
            amplified += uNvgWarmup * 0.75;

            vec3 phosphorBase = vec3(0.10, 0.96, 0.28) * amplified;
            float bloomWhite = smoothstep(0.72, 1.35, amplified);
            vec3 nvgColor = mix(phosphorBase, vec3(0.84, 1.0, 0.88), bloomWhite * 0.78);

            vec2 nvgNoiseCoord = floor(uvG * uResolution * 0.8) + floor(uTime * 60.0) * vec2(29.1, 47.3);
            float spark = hash12(nvgNoiseCoord);
            float fineNoise = (spark - 0.5) * 0.24;
            float brightSpark = step(0.993, spark) * 0.55;
            nvgColor += vec3(0.15, 0.95, 0.35) * (fineNoise + brightSpark);

            float tubeScan = sin(uvG.y * uResolution.y * 1.6) * 0.035;
            nvgColor += tubeScan;

            float tubeEdgeGlow = smoothstep(0.95, 1.08, tubeDist) * (1.0 - smoothstep(1.08, 1.15, tubeDist));
            nvgColor += vec3(0.08, 0.45, 0.16) * tubeEdgeGlow;

            float tubeMask = 1.0 - smoothstep(1.04, 1.16, tubeDist);
            col = nvgColor * tubeMask;
          } else {
            col = col / (1.0 + col * 0.45);
            col = pow(max(col, vec3(0.0)), vec3(0.92, 0.94, 0.97));

            float postLuma = dot(col, vec3(0.299, 0.587, 0.114));
            col = mix(vec3(postLuma), col, 0.86);

            float darkFactor = mix(1.45, 0.32, clamp(postLuma * 1.4, 0.0, 1.0));
            vec2 noiseCoord = floor(uvG * uResolution * 0.65) + floor(uTime * 60.0) * vec2(17.3, 31.7);
            float nR = hash12(noiseCoord + vec2(1.1, 3.7)) - 0.5;
            float nG = hash12(noiseCoord + vec2(5.3, 2.9)) - 0.5;
            float nB = hash12(noiseCoord + vec2(8.7, 9.1)) - 0.5;
            col += vec3(nR, nG, nB) * uGrain * darkFactor * 0.38;

            float scanline = sin(uvG.y * uResolution.y * 1.15 + uTime * 12.0) * 0.012 * uGrain;
            col += scanline;
          }

          if (uDamagePulse > 0.001) {
            float edge = smoothstep(0.15, 1.35, r2);
            col = mix(col, vec3(0.65, 0.02, 0.02), edge * uDamagePulse * 0.85);
          }

          float vignette = 1.0 - smoothstep(0.54, 1.60, r2 * (1.0 + uFisheye * 0.92));
          col *= vignette;

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.postScene.add(quad);
  }

  /**
   * Спавн крапель крові прямо на склі нагрудної камери (при пострілі впритул або пораненні)
   */
  addLensBloodSplatter(count = 4) {
    for (let c = 0; c < count; c++) {
      let slot = this.lensDropsState.length < this.maxLensDrops
        ? this.lensDropsState.length
        : Math.floor(Math.random() * this.maxLensDrops);

      this.lensDropsState[slot] = {
        x: 0.18 + Math.random() * 0.64,
        y: 0.25 + Math.random() * 0.58,
        radius: 0.028 + Math.random() * 0.042,
        streakLen: 0.01,
        dripSpeed: 0.022 + Math.random() * 0.032,
        life: 11.0 + Math.random() * 6.0,
        maxLife: 15.0
      };
    }
  }

  clearLensBlood() {
    this.lensDropsState = [];
    for (let i = 0; i < this.maxLensDrops; i++) {
      this.uniforms.uLensDropsAlpha.value[i] = 0.0;
    }
  }

  updateLensBlood(dt) {
    for (let i = 0; i < this.maxLensDrops; i++) {
      const d = this.lensDropsState[i];
      if (!d || d.life <= 0) {
        this.uniforms.uLensDropsAlpha.value[i] = 0.0;
        continue;
      }
      d.life -= dt;
      // Під дією віртуальної гравітації великі краплі повільно сповзають донизу по склу камери,
      // залишаючи за собою витягнутий червоний слід
      const gravityFactor = Math.max(0.0, d.life / d.maxLife);
      const dy = d.dripSpeed * gravityFactor * dt;
      d.y -= dy;
      d.streakLen = Math.min(0.32, d.streakLen + dy * 1.15);

      this.uniforms.uLensDrops.value[i].set(d.x, d.y, d.radius, d.streakLen);
      this.uniforms.uLensDropsAlpha.value[i] = Math.min(1.0, d.life / 3.5);
    }
  }

  setSize(width, height) {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    this.renderTarget.setSize(w, h);
    this.uniforms.uResolution.value.set(w, h);
  }

  render(scene, camera, dt, elapsed) {
    this.uniforms.uTime.value = elapsed;
    this.updateLensBlood(dt);

    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }
}
