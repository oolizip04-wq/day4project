import { LAYERS, POIS, ROUTES, VIEWS } from '../map3d/data.js'
import { coverImage } from '../api.js'
import { esc } from '../ui.js'

let cleanup = null
let visitorCache = null

const fmt = (n) => (n == null ? '-' : Math.round(n).toLocaleString('ko-KR'))
const ymLabel = (ym) => `${ym.slice(0, 4)}.${ym.slice(5)}`
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }

/** 시간대 프리셋 (하늘·태양·안개) */
const TIMES = {
  day: { label: '낮', elev: 38, azim: 320, turb: 3.2, ray: 1.1, mie: 0.004, mieG: 0.8, exp: 0.6, sunCol: '#fff3df', sunI: 3.2, fog: '#b8d2e6', hemi: 0.3, cloud: '#ffffff' },
  morning: { label: '아침', elev: 14, azim: 85, turb: 6, ray: 1.6, mie: 0.006, mieG: 0.85, exp: 0.52, sunCol: '#ffd2a1', sunI: 2.7, fog: '#e4c8ab', hemi: 0.38, cloud: '#ffe6cc' },
  sunset: { label: '노을', elev: 5, azim: 285, turb: 8, ray: 2.8, mie: 0.012, mieG: 0.9, exp: 0.48, sunCol: '#ff9a55', sunI: 2.3, fog: '#d99d7c', hemi: 0.42, cloud: '#ffc59a' },
}

const lsGet = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

/** /api/visitors → 관광지별 통계 (최신 월, 전년 대비, 12개월 합계, 24개월 추세) */
async function loadVisitorStats() {
  if (visitorCache) return visitorCache
  const res = await fetch('/api/visitors')
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || '관람객 데이터를 불러오지 못했습니다.')
  const months = json.months
  const stats = {}
  for (const site of json.sites) {
    const series = months.map((m) => m.values[site])
    let li = series.length - 1
    while (li >= 0 && series[li] == null) li--
    const latest = li >= 0 ? series[li] : null
    const prev = li >= 12 ? series[li - 12] : null
    const sum12 = series.slice(Math.max(0, li - 11), li + 1).reduce((a, b) => a + (b || 0), 0)
    stats[site] = {
      latest, ym: li >= 0 ? months[li].ym : null,
      yoy: latest != null && prev ? ((latest - prev) / prev) * 100 : null,
      sum12, spark: series.slice(Math.max(0, li - 23), li + 1),
    }
  }
  visitorCache = stats
  return stats
}

export const map3d = {
  title: '3D 제주 지도',
  destroy() { cleanup?.(); cleanup = null },

  async render(el) {
    let quality = lsGet('jeju_map_quality') // 'normal' | 'high' | null(자동)
    el.innerHTML = `
      <section class="page-head">
        <h1>3D 제주 지도</h1>
        <p>한라산·오름·해안·등대·돌하르방·항구·감귤 재배지를 입체 지형 위에서 탐색해 보세요.</p>
      </section>
      <section class="section">
        <div class="map-stage" id="stage">
          <div class="map-gl" id="gl"></div>
          <div class="map-loading" id="loading">3D 지형을 만드는 중…</div>
          <div class="map-layers" id="layers"></div>
          <div class="map-tools">
            <div class="seg" id="views">${VIEWS.map((v, i) => `<button class="${i === 0 ? 'on' : ''}" data-v="${v.id}">${v.label}</button>`).join('')}</div>
            <div class="seg" id="times">${Object.entries(TIMES).map(([k, t], i) => `<button class="${i === 0 ? 'on' : ''}" data-t="${k}">${t.label}</button>`).join('')}</div>
            <label class="ex">수직 과장 <input id="ex" type="range" min="1" max="6" step="0.5" value="2" /><b id="exv">2×</b></label>
            <button class="btn small" id="rot">⟳ 자동 회전</button>
            <button class="btn small" id="qual" title="화질"></button>
          </div>
          <aside class="map-panel" id="panel" hidden></aside>
        </div>
        <p class="muted small hint-line">🖱️ 드래그 회전 · 휠/핀치 확대 · 우클릭(두 손가락) 드래그 이동 · 점을 누르면 자세히 보여요 · 가까이 확대하면 이름표와 숲이 나타납니다.</p>
        <div id="poilist" class="poi-list"></div>
        <p class="muted small src">
          지형: AWS Terrain Tiles(Mapzen, Terrarium)로 만든 수치표고모델(약 190m 격자)을 보간하고 미세 요철을 더해 표현했습니다. 지표 색(숲·초지·밭·암반)은
          해발·경사로 추정한 <b>개념 표현</b>이며 실제 토지피복과 다릅니다. 장소·등대·항구·올레길 위치는 <b>개략값</b>이고 올레길은 시점-종점을 잇는 개념선입니다.
          감귤 재배지는 해발·위치 조건으로 추정한 개념도이며, 관람객 막대는
          <a href="https://www.data.go.kr/" target="_blank" rel="noopener">공공데이터포털</a> 서귀포시 직영관광지 관람객수(최근 12개월 합계)입니다.
        </p>
      </section>`

    let alive = true
    const stage = el.querySelector('#stage')
    const host = el.querySelector('#gl')
    const panel = el.querySelector('#panel')
    const loading = el.querySelector('#loading')

    let THREE, OrbitControls, Sky, dem
    try {
      ;[THREE, { OrbitControls }, { Sky }, dem] = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/objects/Sky.js'),
        fetch('/data/jeju-dem.json').then((r) => { if (!r.ok) throw new Error('지형 데이터를 불러오지 못했습니다.'); return r.json() }),
      ])
    } catch (err) {
      loading.innerHTML = `⚠️ ${esc(err.message)}`
      return
    }
    let teardown = null
    cleanup = () => { alive = false; teardown?.() }
    if (!el.isConnected || !el.querySelector('#stage')) return

    /* ───────────── 렌더러 / 화질 ───────────── */
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    const gl = renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    const software = /swiftshader|software|llvmpipe/i.test(gpu)
    const coarse = matchMedia('(pointer: coarse)').matches || innerWidth < 760
    const auto = software || coarse ? 'normal' : 'high'
    const Q = quality === 'high' || quality === 'normal' ? quality : auto
    const S = Q === 'high' ? 2 : 1                 // 지형 격자 보간 배수
    const SHADOW = Q === 'high' ? 4096 : 2048
    const qualBtn = el.querySelector('#qual')
    qualBtn.textContent = Q === 'high' ? '화질: 높음' : '화질: 보통'
    qualBtn.onclick = () => {
      lsSet('jeju_map_quality', Q === 'high' ? 'normal' : 'high')
      cleanup?.(); cleanup = null
      map3d.render(el)
    }

    renderer.setPixelRatio(Math.min(devicePixelRatio, Q === 'high' ? 2 : 1.5))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog('#b8d2e6', 110, 400)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1200)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 1.2
    controls.maxDistance = 190
    controls.maxPolarAngle = Math.PI * 0.485
    controls.autoRotateSpeed = 0.6

    /* ───────────── 하늘 · 태양 · 환경광 ───────────── */
    const sky = new Sky()
    sky.scale.setScalar(450000)
    scene.add(sky)
    const envScene = new THREE.Scene()
    const envSky = new Sky()
    envSky.scale.setScalar(450000)
    envScene.add(envSky)
    const pmrem = new THREE.PMREMGenerator(renderer)
    let envRT = null

    const hemi = new THREE.HemisphereLight('#cfe4ff', '#6f7a58', 0.3)
    scene.add(hemi)
    const sun = new THREE.DirectionalLight('#fff3df', 3)
    sun.castShadow = true
    sun.shadow.mapSize.set(SHADOW, SHADOW)
    Object.assign(sun.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 1, far: 320 })
    sun.shadow.bias = -0.0003
    sun.shadow.normalBias = 0.06
    scene.add(sun, sun.target)
    scene.environmentIntensity = 0.5

    const sunVec = new THREE.Vector3()
    const cloudMats = []
    let curTime = 'day'
    function applyTime(key) {
      curTime = key
      const t = TIMES[key]
      for (const s of [sky, envSky]) {
        const u = s.material.uniforms
        u.turbidity.value = t.turb; u.rayleigh.value = t.ray; u.mieCoefficient.value = t.mie; u.mieDirectionalG.value = t.mieG
        sunVec.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - t.elev), THREE.MathUtils.degToRad(t.azim))
        u.sunPosition.value.copy(sunVec)
      }
      sun.position.copy(sunVec).multiplyScalar(120)
      sun.color.set(t.sunCol); sun.intensity = t.sunI
      hemi.intensity = t.hemi
      renderer.toneMappingExposure = t.exp
      scene.fog.color.set(t.fog)
      cloudMats.forEach((m) => m.color.set(t.cloud))
      if (envRT) envRT.dispose()
      envRT = pmrem.fromScene(envScene)
      scene.environment = envRT.texture
    }

    /* ───────────── 지형 격자 (보간 + 미세 요철) ───────────── */
    const { w: GW, h: GH, kmW, kmH } = dem
    const [lon0, lon1] = dem.lon, [lat0, lat1] = dem.lat
    const raw = Uint8Array.from(atob(dem.data), (c) => c.charCodeAt(0))
    const D = new Int16Array(raw.buffer)
    const Hm = new Float32Array(GW * GH)
    for (let i = 0; i < Hm.length; i++) Hm[i] = Math.max(D[i], -120)

    const W = (GW - 1) * S + 1, HH = (GH - 1) * S + 1
    const N = W * HH

    const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s) }
    const vnoise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }
    const fbm = (x, y, o = 4) => { let s = 0, a = 0.5, n = 0; for (let i = 0; i < o; i++) { s += a * vnoise(x, y); n += a; x *= 2.03; y *= 2.03; a *= 0.5 } return s / n }

    const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
    const gx = (x, y) => Hm[clamp(y, 0, GH - 1) * GW + clamp(x, 0, GW - 1)]
    function sampleBase(u, v) {
      const x = Math.floor(u), y = Math.floor(v), fx = u - x, fy = v - y
      const row = (yy) => cr(gx(x - 1, yy), gx(x, yy), gx(x + 1, yy), gx(x + 2, yy), fx)
      const val = cr(row(y - 1), row(y), row(y + 1), row(y + 2), fy)
      const a = gx(x, y), b = gx(x + 1, y), c = gx(x, y + 1), d = gx(x + 1, y + 1)
      return clamp(val, Math.min(a, b, c, d) - 4, Math.max(a, b, c, d) + 4)   // 보간 과충돌 방지
    }

    const HG = new Float32Array(N)
    for (let j = 0; j < HH; j++) for (let i = 0; i < W; i++) {
      let h = sampleBase(i / S, j / S)
      if (h > 2) {
        // 능선·사면의 자연스러운 거칠기 (고도가 높을수록 큼)
        const x = (i / (W - 1)) * kmW, z = (j / (HH - 1)) * kmH
        const amp = (3 + 16 * sm(40, 900, h)) * (S === 2 ? 1 : 0.8)
        h += (fbm(x * 4.2, z * 4.2, 4) - 0.5) * 2 * amp * sm(2, 30, h)
      }
      HG[j * W + i] = h
    }

    const xz = (lon, lat) => ({
      x: ((lon - lon0) / (lon1 - lon0)) * kmW - kmW / 2,
      z: -(((lat - lat0) / (lat1 - lat0)) * kmH - kmH / 2),
    })
    const heightAt = (lon, lat) => {
      const u = ((lon - lon0) / (lon1 - lon0)) * (W - 1)
      const v = (1 - (lat - lat0) / (lat1 - lat0)) * (HH - 1)
      const x0 = clamp(Math.floor(u), 0, W - 2), y0 = clamp(Math.floor(v), 0, HH - 2)
      const fx = clamp(u - x0, 0, 1), fy = clamp(v - y0, 0, 1)
      const a = HG[y0 * W + x0], b = HG[y0 * W + x0 + 1], c = HG[(y0 + 1) * W + x0], d = HG[(y0 + 1) * W + x0 + 1]
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
    }

    // 경사(무차원)와 곡률(m, 오목할수록 +)
    const cellM = (kmW * 1000) / (W - 1)
    const slope = new Float32Array(N), curv = new Float32Array(N)
    for (let j = 1; j < HH - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i
      const dx = (HG[k + 1] - HG[k - 1]) / (2 * cellM), dz = (HG[k + W] - HG[k - W]) / (2 * cellM)
      slope[k] = Math.hypot(dx, dz)
      curv[k] = (HG[k - 1] + HG[k + 1] + HG[k - W] + HG[k + W]) / 4 - HG[k]
    }

    /* ───────────── 지표 색 (해발·경사·노이즈로 추정) ───────────── */
    const C = (h) => new THREE.Color(h)
    const P = {
      foam: C('#a8e3dc'), shallow: C('#1f95a9'), mid: C('#0d4c6d'), deep: C('#062a42'),
      sand: C('#d9cba0'), basalt: C('#37373b'),
      g1: C('#6e9a4b'), g2: C('#88a956'), farm1: C('#a99b61'), farm2: C('#8d9050'), meadow: C('#9aab62'),
      forestA: C('#2e5230'), forestB: C('#3b6034'), forestC: C('#44593a'),
      shrub: C('#7f8759'), alpine: C('#98966c'), rock: C('#6d6962'), rockL: C('#8e897f'), summit: C('#a49f95'),
      orch: ['#8aa14a', '#9bb04d', '#7c9547', '#b3b25a', '#6f8d45', '#a2a850'].map(C), hedge: C('#4b693a'),
    }
    const orchardMask = (x, z, h) => {
      const lon = lon0 + ((x + kmW / 2) / kmW) * (lon1 - lon0), lat = lat0 + ((-z + kmH / 2) / kmH) * (lat1 - lat0)
      if (lat > 33.315 || h < 25 || h > 380 || lon < 126.28 || lon > 126.92) return 0
      return clamp((fbm(x * 0.55 + 7, z * 0.55 + 3, 3) - 0.42) * 6, 0, 1)
    }

    const geo = new THREE.PlaneGeometry(kmW, kmH, W - 1, HH - 1)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    const col = new Float32Array(N * 3)
    const ovc = new Float32Array(N * 4)          // 감귤 구역 강조 오버레이(RGBA)
    const flagForest = new Uint8Array(N), flagCoast = new Uint8Array(N), flagOrch = new Uint8Array(N)
    const c = new THREE.Color(), t2 = new THREE.Color()

    for (let i = 0; i < N; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = HG[i], sl = slope[i]
      const n1 = fbm(x * 0.7, z * 0.7, 3), n2 = fbm(x * 2.6 + 11, z * 2.6, 3), n3 = vnoise(x * 11, z * 11)
      if (h <= 0) {
        // 바다 밑: 얕은 곳 터키석 → 깊은 곳 남색, 해안선 부근은 밝은 포말색
        const d = -h
        if (d < 3) c.copy(P.foam).lerp(P.shallow, d / 3)
        else if (d < 25) c.copy(P.shallow).lerp(P.mid, (d - 3) / 22)
        else c.copy(P.mid).lerp(P.deep, clamp((d - 25) / 80, 0, 1))
      } else {
        const om = orchardMask(x, z, h)
        // 기본 고도대
        if (h < 220) {
          c.copy(P.g1).lerp(P.g2, n2)
          const farm = sm(0.5, 0.62, n1)
          if (farm > 0) c.lerp(t2.copy(P.farm1).lerp(P.farm2, n3), farm * 0.8)
          if (om > 0) {
            const cx = Math.floor(x * 2.3), cz = Math.floor(z * 2.3)
            t2.copy(P.orch[Math.floor(hash(cx, cz) * P.orch.length)])
            const fx = x * 2.3 - cx, fz = z * 2.3 - cz
            if (Math.min(fx, 1 - fx, fz, 1 - fz) < 0.07) t2.copy(P.hedge)     // 방풍림·돌담 경계
            c.lerp(t2, om * 0.85)
            if (om > 0.5) flagOrch[i] = 1
          }
          if (sm(120, 220, h) > 0) c.lerp(t2.copy(P.forestB).lerp(P.forestA, n2), sm(120, 260, h) * 0.9)
        } else if (h < 900) {
          c.copy(P.forestA).lerp(P.forestB, n2)
          if (n1 < 0.34 && sl < 0.25) c.lerp(P.meadow, 0.7)             // 오름·초지 느낌의 열린 사면
          c.lerp(P.forestC, sm(600, 900, h) * 0.5)
        } else if (h < 1500) {
          c.copy(P.forestC).lerp(P.shrub, sm(950, 1450, h) * (0.5 + 0.5 * n2))
        } else {
          c.copy(P.shrub).lerp(P.alpine, sm(1500, 1700, h)).lerp(P.rock, sm(1650, 1850, h) * (0.6 + 0.4 * n2)).lerp(P.summit, sm(1880, 1940, h))
        }
        // 해안: 모래 또는 현무암 갯바위
        const cs = 1 - sm(2, 9, h)
        if (cs > 0) {
          t2.copy(n2 > 0.52 ? P.basalt : P.sand)
          c.lerp(t2, cs)
          if (n2 > 0.52 && h < 6) flagCoast[i] = 1
        }
        // 급경사는 암반
        const rk = sm(0.42, 0.95, sl) * sm(15, 120, h)
        if (rk > 0) c.lerp(t2.copy(P.rock).lerp(P.rockL, n3), rk * 0.9)
        if (h > 160 && h < 1350 && sl < 0.6 && rk < 0.4) flagForest[i] = 1
        // 오름 위 오목/볼록 명암(작은 AO)
        c.multiplyScalar(1 - clamp(curv[i] / 28, 0, 0.32) + clamp(-curv[i] / 50, 0, 0.1))
        c.multiplyScalar(0.9 + 0.2 * n3)
        // 오버레이 (감귤 재배 추정 구역 강조)
        if (om > 0.15) { ovc[i * 4] = 1; ovc[i * 4 + 1] = 0.55; ovc[i * 4 + 2] = 0.1; ovc[i * 4 + 3] = om * 0.34 }
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))

    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.9 }))
    terrain.castShadow = true
    terrain.receiveShadow = true
    scene.add(terrain)

    // 감귤 구역 오버레이 (위치·인덱스는 지형과 공유)
    const ovGeo = new THREE.BufferGeometry()
    ovGeo.setAttribute('position', geo.attributes.position)
    ovGeo.setAttribute('color', new THREE.BufferAttribute(ovc, 4))
    ovGeo.setIndex(geo.index)
    const overlay = new THREE.Mesh(ovGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true }))
    overlay.frustumCulled = false
    overlay.position.y = 0.002

    /* ───────────── 바다 ───────────── */
    const normalMap = (() => {
      const SZ = 256, cv = document.createElement('canvas'); cv.width = cv.height = SZ
      const x = cv.getContext('2d'), im = x.createImageData(SZ, SZ)
      const Wv = [[3, 1, 0.5, 0], [2, -3, 0.4, 1.7], [4, 5, 0.3, 3.1], [1, 6, 0.35, 0.6], [7, 2, 0.12, 1.1], [11, -5, 0.05, 2.3]]
      for (let j = 0; j < SZ; j++) for (let i = 0; i < SZ; i++) {
        let dx = 0, dy = 0
        for (const [fx, fy, a, p] of Wv) { const d = Math.cos(2 * Math.PI * (fx * i / SZ + fy * j / SZ) + p) * a * 2 * Math.PI; dx += d * fx; dy += d * fy }
        const nx = -dx * 0.04, ny = -dy * 0.04, l = Math.hypot(nx, ny, 1), k = (j * SZ + i) * 4
        im.data[k] = (nx / l * 0.5 + 0.5) * 255; im.data[k + 1] = (ny / l * 0.5 + 0.5) * 255; im.data[k + 2] = (1 / l * 0.5 + 0.5) * 255; im.data[k + 3] = 255
      }
      x.putImageData(im, 0, 0)
      const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(48, 48); t.anisotropy = 4; return t
    })()
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(560, 560).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#157fa6', transparent: true, opacity: 0.88, roughness: 0.16, metalness: 0.0, envMapIntensity: 1.2, normalMap, normalScale: new THREE.Vector2(0.16, 0.16) }),
    )
    sea.position.y = -0.004
    sea.receiveShadow = true
    scene.add(sea)

    /* ───────────── 구름 ───────────── */
    const cloudTex = (() => {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128
      const x = cv.getContext('2d'); let s = 5
      const r = () => (s = (s * 16807) % 2147483647) / 2147483647
      for (let i = 0; i < 30; i++) {
        const px = 40 + r() * 176, py = 66 + (r() - 0.5) * 26 - Math.abs(px - 128) * 0.05, rad = 16 + r() * 28
        const g = x.createRadialGradient(px, py, 0, px, py, rad); g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)')
        x.fillStyle = g; x.fillRect(px - rad, py - rad, rad * 2, rad * 2)
      }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t
    })()
    const clouds = []
    for (let i = 0; i < 16; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.5, fog: false })
      cloudMats.push(m)
      const sp = new THREE.Sprite(m)
      const a = i * 2.399, rr = 25 + (i % 7) * 15
      sp.position.set(Math.cos(a) * rr * 1.2, 11 + (i % 5) * 2.2, Math.sin(a) * rr)
      const sc = 26 + (i % 4) * 9; sp.scale.set(sc, sc * 0.42, 1)
      scene.add(sp); clouds.push(sp)
    }

    /* ───────────── 레이어 / 모델 ───────────── */
    let ex = 2
    const groups = {}
    LAYERS.forEach((l) => { groups[l.id] = new THREE.Group(); scene.add(groups[l.id]) })
    const detail = new THREE.Group()     // 가까이에서만 보이는 소품(숲, 갯바위)
    scene.add(detail)
    const placed = []
    const clickable = []
    const std = (cc, o = {}) => new THREE.MeshStandardMaterial({ color: cc, roughness: 0.75, metalness: 0, ...o })
    const yAt = (lon, lat) => Math.max(heightAt(lon, lat), 0) / 1000 * ex

    function place(obj, lon, lat, lift, layer) {
      const { x, z } = xz(lon, lat)
      obj.position.set(x, yAt(lon, lat) + lift, z)
      placed.push({ obj, lon, lat, lift })
      groups[layer].add(obj)
    }
    const meshOf = (geom, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); m.castShadow = true; return m }

    function modelLighthouse() {
      const g = new THREE.Group()
      const white = std('#f2f1ec', { roughness: 0.6 }), red = std('#c9362f'), glass = new THREE.MeshStandardMaterial({ color: '#ffe9a8', emissive: '#ffcf55', emissiveIntensity: 1.1, roughness: 0.2 })
      g.add(meshOf(new THREE.CylinderGeometry(0.034, 0.05, 0.3, 28), white, 0, 0.15))
      g.add(meshOf(new THREE.CylinderGeometry(0.0425, 0.0455, 0.05, 28), red, 0, 0.1))
      g.add(meshOf(new THREE.CylinderGeometry(0.0385, 0.0405, 0.05, 28), red, 0, 0.21))
      g.add(meshOf(new THREE.CylinderGeometry(0.056, 0.056, 0.012, 28), std('#33363a'), 0, 0.306))
      const rail = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.003, 6, 32), std('#33363a')); rail.rotation.x = Math.PI / 2; rail.position.y = 0.325; g.add(rail)
      g.add(meshOf(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 24), glass, 0, 0.337))
      g.add(meshOf(new THREE.SphereGeometry(0.034, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 0.362))
      g.add(meshOf(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 6), std('#33363a'), 0, 0.4))
      return g
    }
    function modelHareubang() {
      const g = new THREE.Group()
      const stone = std('#5f5c57', { roughness: 0.98 }), stone2 = std('#6a6762', { roughness: 0.98 }), dark = std('#1f1e1d')
      g.add(meshOf(new THREE.CylinderGeometry(0.036, 0.05, 0.16, 20), stone, 0, 0.08))
      g.add(meshOf(new THREE.SphereGeometry(0.043, 20, 14), stone2, 0, 0.215).scale.set(1, 1.15, 1) || new THREE.Object3D())
      const head = meshOf(new THREE.SphereGeometry(0.043, 20, 14), stone2, 0, 0.215); head.scale.set(1, 1.15, 1); g.add(head)
      g.add(meshOf(new THREE.CylinderGeometry(0.058, 0.05, 0.022, 24), stone, 0, 0.255))
      const dome = meshOf(new THREE.SphereGeometry(0.04, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), stone, 0, 0.265); dome.scale.set(1.15, 0.9, 1.15); g.add(dome)
      for (const s of [-1, 1]) {
        const eye = meshOf(new THREE.SphereGeometry(0.008, 10, 8), dark, s * 0.017, 0.222, 0.037); eye.scale.set(1, 1.4, 0.6); g.add(eye)
        const arm = meshOf(new THREE.CylinderGeometry(0.009, 0.009, 0.07, 8), stone, s * 0.034, 0.12, 0.018); arm.rotation.z = s * -0.25; g.add(arm)
        g.add(meshOf(new THREE.SphereGeometry(0.011, 10, 8), stone, s * 0.014, 0.1, 0.045))
      }
      g.add(meshOf(new THREE.BoxGeometry(0.014, 0.022, 0.012), stone, 0, 0.205, 0.042))
      g.scale.setScalar(0.85)
      return g
    }
    function boatMesh(col) {
      const sh = new THREE.Shape()
      sh.moveTo(-0.07, -0.022); sh.lineTo(0.05, -0.024); sh.quadraticCurveTo(0.095, 0, 0.11, 0); sh.quadraticCurveTo(0.095, 0, 0.05, 0.024); sh.lineTo(-0.07, 0.022); sh.closePath()
      const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false }), std(col, { roughness: 0.5 }))
      hull.rotation.x = -Math.PI / 2; hull.position.y = 0.012; hull.castShadow = true
      const g = new THREE.Group(); g.add(hull)
      g.add(meshOf(new THREE.BoxGeometry(0.04, 0.03, 0.03), std('#f4f4f1'), -0.02, 0.058, 0))
      g.add(meshOf(new THREE.CylinderGeometry(0.002, 0.002, 0.07, 6), std('#555'), 0.02, 0.085, 0))
      return g
    }
    function modelPort() {
      const g = new THREE.Group()
      const conc = std('#9d9c98', { roughness: 0.95 })
      const wall = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.016, 8, 40, Math.PI * 0.75), conc)
      wall.rotation.x = -Math.PI / 2; wall.position.set(-0.05, 0.016, 0.1); wall.castShadow = true; g.add(wall)
      const tip = meshOf(new THREE.CylinderGeometry(0.014, 0.018, 0.07, 14), std('#c9362f'), 0.17, 0.05, -0.1); g.add(tip)
      g.add(meshOf(new THREE.BoxGeometry(0.34, 0.016, 0.07), std('#8a6a45', { roughness: 0.9 }), 0, 0.01, 0))
      const b1 = boatMesh('#2f5f8f'); b1.position.set(0.06, 0, 0.09); g.add(b1)
      const b2 = boatMesh('#d8483c'); b2.position.set(-0.07, 0, 0.12); b2.rotation.y = 0.5; g.add(b2)
      return g
    }
    function modelTree() {
      const g = new THREE.Group()
      g.add(meshOf(new THREE.CylinderGeometry(0.011, 0.016, 0.07, 8), std('#6b4a2f'), 0, 0.035))
      const canopy = meshOf(new THREE.IcosahedronGeometry(0.07, 1), std('#3f8f3c'), 0, 0.115); canopy.scale.y = 0.85; g.add(canopy)
      for (let i = 0; i < 8; i++) {
        const o = meshOf(new THREE.SphereGeometry(0.016, 8, 6), std('#ff8a1f'), 0, 0, 0)
        const a = (i / 8) * Math.PI * 2; o.position.set(Math.cos(a) * 0.065, 0.115 + (i % 3 - 1) * 0.028, Math.sin(a) * 0.065); g.add(o)
      }
      return g
    }
    const MODELS = { lighthouse: modelLighthouse, hareubang: modelHareubang, port: modelPort, orchard: modelTree }

    function makeLabel(text, emoji, color, scaleY = 0.05) {
      const font = '600 26px "Malgun Gothic","Noto Sans KR",sans-serif'
      const m = document.createElement('canvas').getContext('2d'); m.font = font
      const tw = Math.ceil(m.measureText(`${emoji} ${text}`).width)
      const cv = document.createElement('canvas'); cv.width = tw + 34; cv.height = 64
      const x = cv.getContext('2d')
      const rr = (a, b, w, h, r) => { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath() }
      x.fillStyle = 'rgba(255,255,255,.96)'; rr(2, 2, cv.width - 4, 44, 22); x.fill()
      x.lineWidth = 3; x.strokeStyle = color; x.stroke()
      x.beginPath(); x.moveTo(cv.width / 2 - 8, 45); x.lineTo(cv.width / 2, 60); x.lineTo(cv.width / 2 + 8, 45); x.closePath(); x.fillStyle = 'rgba(255,255,255,.96)'; x.fill()
      x.font = font; x.textBaseline = 'middle'; x.fillStyle = '#1d2329'; x.fillText(`${emoji} ${text}`, 17, 25)
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false, toneMapped: false, fog: false }))
      s.center.set(0.5, 0)
      s.scale.set((cv.width / cv.height) * scaleY, scaleY, 1)
      s.userData.base = s.scale.clone()
      return s
    }
    function makeDot(color) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 48
      const x = cv.getContext('2d')
      x.beginPath(); x.arc(24, 24, 20, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill()
      x.beginPath(); x.arc(24, 24, 14, 0, Math.PI * 2); x.fillStyle = color; x.fill()
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false, toneMapped: false, fog: false }))
      s.scale.set(0.022, 0.022, 1); s.userData.base = s.scale.clone()
      return s
    }
    const LABEL_DIST = { spots: 62, lighthouse: 48, hareubang: 48, port: 48, orchard: 48, olle: 48, bars: 80 }

    const layerMeta = Object.fromEntries(LAYERS.map((l) => [l.id, l]))
    for (const p of POIS) {
      const meta = layerMeta[p.layer]
      const model = MODELS[p.layer]?.()
      const holder = new THREE.Group()
      if (model) holder.add(model)
      const label = makeLabel(p.name, meta.emoji, meta.color, p.big ? 0.056 : 0.046)
      label.position.y = model ? 0.5 : p.big ? 0.5 : 0.34
      label.userData.layer = p.layer
      label.userData.maxDist = p.big ? 999 : LABEL_DIST[p.layer]
      holder.add(label)
      const dot = makeDot(meta.color)
      dot.position.y = model ? 0.48 : p.big ? 0.48 : 0.32
      dot.userData.layer = p.layer
      holder.add(dot)
      place(holder, p.lon, p.lat, 0, p.layer)
      clickable.push({ sprite: label, poi: p }, { sprite: dot, poi: p })
    }

    /* 숲 · 갯바위 · 감귤나무 (인스턴싱) */
    const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()
    function sampleFlag(flag, max, tries) {
      const out = []
      for (let k = 0; k < tries && out.length < max; k++) {
        const i = Math.floor(rnd() * N)
        if (flag[i]) out.push(i)
      }
      return out
    }
    const dummy = new THREE.Object3D()
    function instanced(geom, mat, idxs, colorFn, sizeFn) {
      const m = new THREE.InstancedMesh(geom, mat, idxs.length)
      const cc = new THREE.Color()
      const items = idxs.map((i) => {
        const jx = (rnd() - 0.5) * (kmW / W) * 1.4, jz = (rnd() - 0.5) * (kmH / HH) * 1.4
        return { x: pos.getX(i) + jx, z: pos.getZ(i) + jz, h: HG[i], s: sizeFn(), r: rnd() * 6.28 }
      })
      items.forEach((it, k) => { cc.set(colorFn()); m.setColorAt(k, cc) })
      m.userData.items = items
      m.frustumCulled = false
      return m
    }
    const forestMesh = instanced(new THREE.ConeGeometry(0.017, 0.075, 6), new THREE.MeshLambertMaterial(), sampleFlag(flagForest, S === 2 ? 36000 : 22000, 400000),
      () => ['#2f5a32', '#3a6a38', '#2a4f2c', '#456a3a', '#35603a'][Math.floor(rnd() * 5)], () => 0.7 + rnd() * 0.8)
    const rockMesh = instanced(new THREE.IcosahedronGeometry(0.012, 0), new THREE.MeshStandardMaterial({ roughness: 1 }), sampleFlag(flagCoast, 7000, 500000),
      () => ['#2f2f33', '#3b3b40', '#26262a'][Math.floor(rnd() * 3)], () => 0.6 + rnd() * 1.6)
    const orchardTrees = instanced(new THREE.IcosahedronGeometry(0.02, 0), new THREE.MeshLambertMaterial(), sampleFlag(flagOrch, 3500, 300000),
      () => (rnd() < 0.35 ? '#ff8a1f' : rnd() < 0.5 ? '#3f8f3c' : '#5aa84b'), () => 0.8 + rnd() * 0.6)
    detail.add(forestMesh, rockMesh)
    groups.orchard.add(overlay, orchardTrees)

    function updateInstances() {
      for (const [m, lift] of [[forestMesh, 0.03], [rockMesh, 0.004], [orchardTrees, 0.014]]) {
        const items = m.userData.items
        items.forEach((it, k) => {
          dummy.position.set(it.x, Math.max(it.h, 0) / 1000 * ex + lift * it.s, it.z)
          dummy.rotation.set(0, it.r, 0); dummy.scale.setScalar(it.s); dummy.updateMatrix()
          m.setMatrixAt(k, dummy.matrix)
        })
        m.instanceMatrix.needsUpdate = true
      }
    }

    /* 올레길 */
    const routeMeshes = []
    function buildRoutes() {
      routeMeshes.forEach((m) => { groups.olle.remove(m); m.geometry.dispose() })
      routeMeshes.length = 0
      for (const r of ROUTES) {
        const pts = r.pts.map(([lon, lat]) => { const { x, z } = xz(lon, lat); return new THREE.Vector3(x, yAt(lon, lat) + 0.07, z) })
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4)
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 90, 0.032, 8), new THREE.MeshStandardMaterial({ color: r.color, emissive: r.color, emissiveIntensity: 0.4, roughness: 0.5 }))
        groups.olle.add(tube); routeMeshes.push(tube)
      }
    }
    for (const r of ROUTES) {
      const mid = r.pts[Math.floor(r.pts.length / 2)]
      const poi = { id: r.id, layer: 'olle', kind: '올레길(개략)', name: r.name.replace(/ 개략$/, ''), lon: mid[0], lat: mid[1], query: 'jeju olle trail walking', desc: r.desc, tip: '표시된 선은 시점과 종점을 잇는 개념선입니다. 실제 코스는 제주올레 공식 지도를 확인하세요.' }
      const label = makeLabel(poi.name, '🥾', r.color, 0.044)
      label.position.y = 0.3
      label.userData.layer = 'olle'; label.userData.maxDist = LABEL_DIST.olle
      const dot = makeDot(r.color); dot.position.y = 0.28; dot.userData.layer = 'olle'
      const holder = new THREE.Group(); holder.add(label, dot)
      place(holder, mid[0], mid[1], 0, 'olle')
      clickable.push({ sprite: label, poi }, { sprite: dot, poi })
    }

    /* 관람객 막대 (공공데이터) */
    async function addBars() {
      const chip = el.querySelector('[data-l="bars"]')
      try {
        const stats = await loadVisitorStats()
        if (!alive) return
        const withStat = POIS.filter((p) => p.stat && stats[p.stat])
        const max = Math.max(1, ...withStat.map((p) => stats[p.stat].sum12))
        for (const p of withStat) {
          const st = stats[p.stat], hgt = 0.4 + (st.sum12 / max) * 2.6
          const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 24), new THREE.MeshStandardMaterial({ color: '#1fb5a8', emissive: '#0f7f76', emissiveIntensity: 0.45, roughness: 0.35, transparent: true, opacity: 0.92 }))
          bar.scale.y = hgt
          const holder = new THREE.Group(); holder.add(bar)
          bar.position.y = hgt / 2
          const lab = makeLabel(`${(st.sum12 / 10000).toFixed(0)}만명/년`, '📊', '#1fb5a8', 0.04)
          lab.position.y = hgt + 0.05; lab.userData.layer = 'bars'; lab.userData.maxDist = LABEL_DIST.bars
          holder.add(lab)
          place(holder, p.lon + 0.004, p.lat + 0.004, 0, 'bars')
          clickable.push({ sprite: lab, poi: p })
        }
        chip?.classList.remove('loading')
      } catch (err) {
        chip?.classList.add('off'); chip?.setAttribute('title', err.message)
        groups.bars.visible = false
        chip?.classList.remove('on', 'loading')
      }
    }

    /* 수직 과장 적용 */
    function applyEx(v) {
      ex = v
      for (let i = 0; i < N; i++) pos.setY(i, HG[i] / 1000 * ex)
      pos.needsUpdate = true
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
      for (const p of placed) p.obj.position.y = yAt(p.lon, p.lat) + p.lift
      updateInstances(); buildRoutes()
    }
    applyEx(2)
    applyTime('day')

    /* ───────────── UI ───────────── */
    const layersEl = el.querySelector('#layers')
    layersEl.innerHTML = LAYERS.map((l) => `<button class="chip on ${l.id === 'bars' ? 'loading' : ''}" data-l="${l.id}" style="--c:${l.color}"><i></i>${l.emoji} ${l.label}</button>`).join('')
    layersEl.onclick = (e) => {
      const b = e.target.closest('.chip'); if (!b || b.classList.contains('off')) return
      const on = !groups[b.dataset.l].visible
      groups[b.dataset.l].visible = on
      b.classList.toggle('on', on)
    }

    const list = el.querySelector('#poilist')
    const allPoi = [...POIS, ...clickable.filter((cl) => cl.poi.layer === 'olle').map((cl) => cl.poi)]
    list.innerHTML = LAYERS.filter((l) => l.id !== 'bars').map((l) => `
      <div class="poi-group"><h4>${l.emoji} ${l.label}</h4><div class="chips">
        ${allPoi.filter((p) => p.layer === l.id).map((p) => `<button class="chip" data-p="${p.id}">${esc(p.name)}</button>`).join('')}
      </div></div>`).join('')
    list.onclick = (e) => {
      const b = e.target.closest('[data-p]'); if (!b) return
      const p = allPoi.find((x) => x.id === b.dataset.p)
      if (p) { openPanel(p); stage.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    }

    let fly = null
    const ease = (t) => t * t * (3 - 2 * t)
    function flyTo(target, camPos, dur = 1.2) {
      fly = { t: 0, dur, fromT: controls.target.clone(), toT: target, fromP: camera.position.clone(), toP: camPos }
      controls.autoRotate = false; rotBtn.classList.remove('on')
    }
    const dirTo = (d) => new THREE.Vector3(d[0], d[1], d[2]).normalize()
    function flyView(v) {
      const { x, z } = xz(v.target[0], v.target[1])
      const t = new THREE.Vector3(x, yAt(v.target[0], v.target[1]) * 0.6, z)
      flyTo(t, t.clone().add(dirTo(v.dir).multiplyScalar(v.dist)))
    }
    const viewsEl = el.querySelector('#views')
    viewsEl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return
      viewsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      flyView(VIEWS.find((v) => v.id === b.dataset.v))
    }
    const timesEl = el.querySelector('#times')
    timesEl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return
      timesEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      applyTime(b.dataset.t)
    }
    const rotBtn = el.querySelector('#rot')
    rotBtn.onclick = () => { controls.autoRotate = !controls.autoRotate; rotBtn.classList.toggle('on', controls.autoRotate) }
    const exInput = el.querySelector('#ex')
    exInput.oninput = () => { el.querySelector('#exv').textContent = `${exInput.value}×` }
    exInput.onchange = () => applyEx(Number(exInput.value))

    let selected = null
    async function openPanel(p) {
      selected = p
      const { x, z } = xz(p.lon, p.lat)
      const t = new THREE.Vector3(x, yAt(p.lon, p.lat), z)
      flyTo(t, t.clone().add(new THREE.Vector3(-0.55, 0.62, 0.85).normalize().multiplyScalar(p.big ? 14 : 7.5)))
      const meta = layerMeta[p.layer]
      panel.hidden = false
      panel.innerHTML = `
        <button class="panel-x" aria-label="닫기">✕</button>
        <div class="panel-img" id="pimg"></div>
        <div class="panel-body">
          <span class="tag" style="background:${meta.color}22;color:${meta.color}">${esc(meta.emoji)} ${esc(p.kind)}</span>
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.desc)}</p>
          <p class="tip">💡 ${esc(p.tip)}</p>
          <div id="pstat"></div>
          <a class="more" href="/explore?q=${encodeURIComponent(p.query)}" data-link>Pixabay 사진 더 보기 →</a>
          <p class="muted small">위치는 개략값입니다.</p>
        </div>`
      panel.querySelector('.panel-x').onclick = () => { panel.hidden = true; selected = null }
      coverImage(p.query).then((hit) => {
        const box = panel.querySelector('#pimg')
        if (hit && box && selected === p) { box.style.backgroundImage = `url("${hit.thumb}")`; box.classList.add('loaded') }
      })
      if (p.stat) {
        try {
          const st = (await loadVisitorStats())[p.stat]
          if (!st || selected !== p) return
          const vals = st.spark.map((v) => v ?? 0), mx = Math.max(1, ...vals)
          const path = vals.map((v, i) => `${i ? 'L' : 'M'}${(i / (vals.length - 1)) * 200},${40 - (v / mx) * 36}`).join('')
          panel.querySelector('#pstat').innerHTML = `
            <div class="poi-stat">
              <span class="muted small">월 관람객 (${ymLabel(st.ym)}) · 공공데이터</span>
              <b>${fmt(st.latest)}명</b>
              ${st.yoy != null ? `<em class="${st.yoy >= 0 ? 'up' : 'down'}">${st.yoy >= 0 ? '▲' : '▼'} ${Math.abs(st.yoy).toFixed(1)}% 전년 동월 대비</em>` : ''}
              <span class="muted small">최근 12개월 합계 ${fmt(st.sum12)}명</span>
              <svg viewBox="0 0 200 44" class="spark"><path d="${path}" fill="none" stroke="#1fb5a8" stroke-width="2" stroke-linejoin="round" /></svg>
            </div>`
        } catch { /* 통계 실패는 조용히 무시 */ }
      }
    }

    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const dom = renderer.domElement
    const visibleHits = () => clickable.filter((cl) => groups[cl.sprite.userData.layer].visible && cl.sprite.visible).map((cl) => cl.sprite)
    function pick(e) {
      const r = dom.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const hit = ray.intersectObjects(visibleHits(), false)[0]
      return hit ? clickable.find((cl) => cl.sprite === hit.object) : null
    }
    let down = null, hovered = null
    dom.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; controls.autoRotate = false; rotBtn.classList.remove('on'); fly = null })
    dom.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return
      const cl = pick(e); if (cl) openPanel(cl.poi)
    })
    dom.addEventListener('pointermove', (e) => {
      if (e.buttons) return
      const cl = pick(e)
      if (cl !== hovered) {
        if (hovered) hovered.sprite.scale.copy(hovered.sprite.userData.base)
        hovered = cl
        if (cl) cl.sprite.scale.copy(cl.sprite.userData.base).multiplyScalar(1.18)
        dom.style.cursor = cl ? 'pointer' : 'grab'
      }
    })

    const resize = () => {
      const w = host.clientWidth || 800, h = host.clientHeight || 520
      renderer.setSize(w, h, false); dom.style.width = '100%'; dom.style.height = '100%'
      camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize); ro.observe(host); resize()

    camera.position.set(0, 62, 78); controls.target.set(0, 0, 0)
    flyView(VIEWS[0]); fly.dur = 0.01
    const bx = kmW / 2 + 6, bz = kmH / 2 + 6
    controls.addEventListener('change', () => {
      controls.target.x = clamp(controls.target.x, -bx, bx)
      controls.target.z = clamp(controls.target.z, -bz, bz)
    })

    let raf = 0, last = performance.now()
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      if (fly) {
        fly.t += dt
        const k = ease(Math.min(1, fly.t / fly.dur))
        controls.target.lerpVectors(fly.fromT, fly.toT, k)
        camera.position.lerpVectors(fly.fromP, fly.toP, k)
        if (fly.t >= fly.dur) fly = null
      }
      normalMap.offset.x += dt * 0.004; normalMap.offset.y -= dt * 0.006
      for (const sp of clouds) { sp.position.x += dt * 0.35; if (sp.position.x > 160) sp.position.x = -160 }
      controls.update()
      const camDist = camera.position.distanceTo(controls.target)
      for (const cl of clickable) { const md = cl.sprite.userData.maxDist; if (md) cl.sprite.visible = camDist < md || hovered?.poi === cl.poi || selected === cl.poi }
      detail.visible = camDist < 46
      orchardTrees.visible = camDist < 26
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(loop)
    loading.hidden = true
    addBars()

    teardown = () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose()
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
        ms.forEach((m) => { m.map?.dispose(); m.dispose() })
      })
      envRT?.dispose(); pmrem.dispose(); normalMap.dispose(); cloudTex.dispose()
      renderer.dispose(); renderer.forceContextLoss()
    }
    if (!alive) teardown()
  },
}
