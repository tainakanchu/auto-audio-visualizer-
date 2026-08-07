/**
 * GENERATED FILE — 手で編集しないこと。
 * `pnpm measure:coverage` で再生成する。
 *
 * Generator ごとの画面占有度の実測値。意味と測り方は ./coverage.ts と
 * ./gl/coverageMeasure.ts を参照。要点だけ:
 *
 * - 256x256 の WebGL2 オフスクリーンで実測
 * - 時刻 0 / 1.7 / 4.3 / 9.1 秒の 4 サンプルを平均
 * - パラメータは seed "coverage-v1" から決定的に引いた
 *   8 セット。その分布が p10 / p50 / p90
 * - source は material 無しの単体（fragColor = vec4(v,v,v,v)）で測る
 * - source 以外は基準 source "grid" の上で測る。基準は
 *   全コンテキストで同一パラメータなので、"grid" のエントリとの
 *   差がその operator の寄与になる
 * - solidFraction はアルファ > 0.5 のピクセル比率
 */
import type { CoverageTable } from './coverage';

export const GENERATOR_COVERAGE: CoverageTable = {
  asanoha: {
    meanAlpha: { p10: 0.2953, p50: 0.4043, p90: 0.4934 },
    solidFraction: { p10: 0.2912, p50: 0.4154, p90: 0.529 },
  },
  asphaltIridescence: {
    meanAlpha: { p10: 0.5008, p50: 0.7502, p90: 0.8416 },
    solidFraction: { p10: 0.4863, p50: 0.7953, p90: 0.9104 },
  },
  barcode: {
    meanAlpha: { p10: 0.3674, p50: 0.458, p90: 0.5473 },
    solidFraction: { p10: 0.3652, p50: 0.4525, p90: 0.5652 },
  },
  bathroomGlaze: {
    meanAlpha: { p10: 0.4791, p50: 0.7265, p90: 0.8403 },
    solidFraction: { p10: 0.4865, p50: 0.7947, p90: 0.901 },
  },
  beatMoire: {
    meanAlpha: { p10: 0.4536, p50: 0.7063, p90: 0.8294 },
    solidFraction: { p10: 0.4472, p50: 0.761, p90: 0.9029 },
  },
  bellowsHose: {
    meanAlpha: { p10: 0.0596, p50: 0.0636, p90: 0.0705 },
    solidFraction: { p10: 0.0527, p50: 0.0566, p90: 0.0658 },
  },
  blueprint: {
    meanAlpha: { p10: 0.6123, p50: 0.8344, p90: 0.8949 },
    solidFraction: { p10: 0.5746, p50: 0.8985, p90: 0.9584 },
  },
  brakeLightRain: {
    meanAlpha: { p10: 0.2645, p50: 0.6374, p90: 0.8084 },
    solidFraction: { p10: 0.2293, p50: 0.6925, p90: 0.8986 },
  },
  branch: {
    meanAlpha: { p10: 0.4674, p50: 0.9803, p90: 1.0 },
    solidFraction: { p10: 0.4683, p50: 0.9803, p90: 1.0 },
  },
  busJacquard: {
    meanAlpha: { p10: 0.2308, p50: 0.3261, p90: 0.4404 },
    solidFraction: { p10: 0.2252, p50: 0.3276, p90: 0.4625 },
  },
  busPolarization: {
    meanAlpha: { p10: 0.3065, p50: 0.6979, p90: 0.922 },
    solidFraction: { p10: 0.2658, p50: 0.715, p90: 0.9303 },
  },
  cassetteWindow: {
    meanAlpha: { p10: 0.0639, p50: 0.0931, p90: 0.1407 },
    solidFraction: { p10: 0.0595, p50: 0.0863, p90: 0.1326 },
  },
  cdDiffraction: {
    meanAlpha: { p10: 0.4094, p50: 0.7685, p90: 0.9534 },
    solidFraction: { p10: 0.3509, p50: 0.8063, p90: 0.9567 },
  },
  cells: {
    meanAlpha: { p10: 0.1898, p50: 0.2262, p90: 0.27 },
    solidFraction: { p10: 0.0794, p50: 0.0982, p90: 0.1679 },
  },
  chainlink: {
    meanAlpha: { p10: 0.4277, p50: 0.9066, p90: 0.9995 },
    solidFraction: { p10: 0.4301, p50: 0.9221, p90: 1.0 },
  },
  cheapLed: {
    meanAlpha: { p10: 0.0667, p50: 0.1161, p90: 0.1594 },
    solidFraction: { p10: 0.0639, p50: 0.1162, p90: 0.1574 },
  },
  checker: {
    meanAlpha: { p10: 0.5, p50: 0.5, p90: 0.5 },
    solidFraction: { p10: 0.5, p50: 0.5, p90: 0.5 },
  },
  concentric: {
    meanAlpha: { p10: 0.6224, p50: 0.9996, p90: 1.0 },
    solidFraction: { p10: 0.6241, p50: 0.9996, p90: 1.0 },
  },
  coneField: {
    meanAlpha: { p10: 0.5177, p50: 0.7798, p90: 0.8887 },
    solidFraction: { p10: 0.5324, p50: 0.8087, p90: 0.9166 },
  },
  contour: {
    meanAlpha: { p10: 0.1056, p50: 0.1652, p90: 0.3844 },
    solidFraction: { p10: 0.1057, p50: 0.1651, p90: 0.395 },
  },
  corruptSave: {
    meanAlpha: { p10: 0.4955, p50: 0.7781, p90: 0.8974 },
    solidFraction: { p10: 0.5027, p50: 0.8054, p90: 0.9135 },
  },
  crossingParallax: {
    meanAlpha: { p10: 0.4918, p50: 0.7784, p90: 0.8955 },
    solidFraction: { p10: 0.4921, p50: 0.807, p90: 0.9145 },
  },
  crt: {
    meanAlpha: { p10: 0.3562, p50: 0.4945, p90: 0.6434 },
    solidFraction: { p10: 0.345, p50: 0.5209, p90: 0.7566 },
  },
  dropout: {
    meanAlpha: { p10: 0.1022, p50: 0.3096, p90: 0.7498 },
    solidFraction: { p10: 0.1057, p50: 0.3139, p90: 0.7666 },
  },
  fanGuard: {
    meanAlpha: { p10: 0.1306, p50: 0.213, p90: 0.2868 },
    solidFraction: { p10: 0.1309, p50: 0.2138, p90: 0.2893 },
  },
  flow: {
    meanAlpha: { p10: 0.4942, p50: 0.7794, p90: 0.884 },
    solidFraction: { p10: 0.49, p50: 0.8087, p90: 0.9169 },
  },
  fluorescent: {
    meanAlpha: { p10: 0.326, p50: 0.6932, p90: 0.8895 },
    solidFraction: { p10: 0.3021, p50: 0.7591, p90: 0.9286 },
  },
  flyoverBeams: {
    meanAlpha: { p10: 0.0209, p50: 0.0282, p90: 0.0599 },
    solidFraction: { p10: 0.0202, p50: 0.0292, p90: 0.0618 },
  },
  freezerCyan: {
    meanAlpha: { p10: 0.3246, p50: 0.7173, p90: 0.9281 },
    solidFraction: { p10: 0.2648, p50: 0.7379, p90: 0.9355 },
  },
  gamma: {
    meanAlpha: { p10: 0.4276, p50: 0.6583, p90: 0.8941 },
    solidFraction: { p10: 0.4345, p50: 0.659, p90: 0.9134 },
  },
  gate: {
    meanAlpha: { p10: 0.0, p50: 0.3874, p90: 0.6938 },
    solidFraction: { p10: 0.0, p50: 0.3991, p90: 0.7136 },
  },
  goldfoil: {
    meanAlpha: { p10: 0.4383, p50: 0.6823, p90: 0.7923 },
    solidFraction: { p10: 0.4591, p50: 0.7744, p90: 0.8993 },
  },
  grain: {
    meanAlpha: { p10: 0.4831, p50: 0.7569, p90: 0.8702 },
    solidFraction: { p10: 0.4881, p50: 0.7972, p90: 0.9128 },
  },
  grid: {
    meanAlpha: { p10: 0.4946, p50: 0.7781, p90: 0.8973 },
    solidFraction: { p10: 0.502, p50: 0.805, p90: 0.9132 },
  },
  grille: {
    meanAlpha: { p10: 0.3148, p50: 0.5289, p90: 0.8004 },
    solidFraction: { p10: 0.3189, p50: 0.5338, p90: 0.8037 },
  },
  halftone: {
    meanAlpha: { p10: 0.478, p50: 0.7421, p90: 0.8573 },
    solidFraction: { p10: 0.4796, p50: 0.7796, p90: 0.9012 },
  },
  harborBackwash: {
    meanAlpha: { p10: 0.4895, p50: 0.7809, p90: 0.8933 },
    solidFraction: { p10: 0.4862, p50: 0.8086, p90: 0.9153 },
  },
  hexGrid: {
    meanAlpha: { p10: 0.2693, p50: 0.7547, p90: 0.959 },
    solidFraction: { p10: 0.2702, p50: 0.7602, p90: 0.9629 },
  },
  hillClimb: {
    meanAlpha: { p10: 0.4938, p50: 0.7795, p90: 0.8985 },
    solidFraction: { p10: 0.4851, p50: 0.8062, p90: 0.9166 },
  },
  humidGalvanized: {
    meanAlpha: { p10: 0.3067, p50: 0.7095, p90: 0.9264 },
    solidFraction: { p10: 0.27, p50: 0.7255, p90: 0.9348 },
  },
  humidityLens: {
    meanAlpha: { p10: 0.4981, p50: 0.7814, p90: 0.8933 },
    solidFraction: { p10: 0.4977, p50: 0.8102, p90: 0.9163 },
  },
  ink: {
    meanAlpha: { p10: 0.2083, p50: 0.6378, p90: 0.9313 },
    solidFraction: { p10: 0.0, p50: 0.6135, p90: 0.9394 },
  },
  interlaceComb: {
    meanAlpha: { p10: 0.5128, p50: 0.7789, p90: 0.8831 },
    solidFraction: { p10: 0.5225, p50: 0.8143, p90: 0.9157 },
  },
  invert: {
    meanAlpha: { p10: 0.2753, p50: 0.568, p90: 0.7613 },
    solidFraction: { p10: 0.1507, p50: 0.6277, p90: 0.8959 },
  },
  kaleido: {
    meanAlpha: { p10: 0.5159, p50: 0.773, p90: 0.8906 },
    solidFraction: { p10: 0.5186, p50: 0.8084, p90: 0.9151 },
  },
  karaokeLcd: {
    meanAlpha: { p10: 0.3539, p50: 0.7339, p90: 0.9404 },
    solidFraction: { p10: 0.3107, p50: 0.771, p90: 0.9465 },
  },
  kumiko: {
    meanAlpha: { p10: 0.0881, p50: 0.1426, p90: 0.2761 },
    solidFraction: { p10: 0.085, p50: 0.1494, p90: 0.2755 },
  },
  macroblock: {
    meanAlpha: { p10: 0.4398, p50: 0.7981, p90: 0.9053 },
    solidFraction: { p10: 0.4347, p50: 0.8125, p90: 0.9126 },
  },
  minidvFade: {
    meanAlpha: { p10: 0.4916, p50: 0.747, p90: 0.8435 },
    solidFraction: { p10: 0.4933, p50: 0.8075, p90: 0.9132 },
  },
  mirror: {
    meanAlpha: { p10: 0.4946, p50: 0.7781, p90: 0.8973 },
    solidFraction: { p10: 0.502, p50: 0.805, p90: 0.9132 },
  },
  misprint: {
    meanAlpha: { p10: 0.4181, p50: 0.7494, p90: 0.9496 },
    solidFraction: { p10: 0.3454, p50: 0.7908, p90: 0.953 },
  },
  mooringRope: {
    meanAlpha: { p10: 0.0997, p50: 0.1505, p90: 0.1817 },
    solidFraction: { p10: 0.105, p50: 0.1812, p90: 0.2245 },
  },
  neon: {
    meanAlpha: { p10: 0.3421, p50: 0.7032, p90: 0.9297 },
    solidFraction: { p10: 0.2934, p50: 0.7336, p90: 0.9342 },
  },
  nicotineCeiling: {
    meanAlpha: { p10: 0.3313, p50: 0.7221, p90: 0.9321 },
    solidFraction: { p10: 0.2989, p50: 0.7491, p90: 0.9401 },
  },
  nightMarketCurtain: {
    meanAlpha: { p10: 0.629, p50: 0.6475, p90: 0.6756 },
    solidFraction: { p10: 0.9963, p50: 0.9993, p90: 1.0 },
  },
  noise: {
    meanAlpha: { p10: 0.5518, p50: 0.7828, p90: 0.8753 },
    solidFraction: { p10: 0.5828, p50: 0.8336, p90: 0.9272 },
  },
  outline: {
    meanAlpha: { p10: 0.0098, p50: 0.1143, p90: 0.3176 },
    solidFraction: { p10: 0.0097, p50: 0.1115, p90: 0.3009 },
  },
  paCarpet: {
    meanAlpha: { p10: 0.4471, p50: 0.7019, p90: 0.8098 },
    solidFraction: { p10: 0.4676, p50: 0.7824, p90: 0.9051 },
  },
  pcbMaze: {
    meanAlpha: { p10: 0.1224, p50: 0.1465, p90: 0.1911 },
    solidFraction: { p10: 0.1174, p50: 0.1365, p90: 0.1666 },
  },
  petals: {
    meanAlpha: { p10: 0.1297, p50: 0.5376, p90: 0.5872 },
    solidFraction: { p10: 0.1324, p50: 0.5722, p90: 0.6304 },
  },
  pixelate: {
    meanAlpha: { p10: 0.3704, p50: 0.7839, p90: 0.8764 },
    solidFraction: { p10: 0.3665, p50: 0.7838, p90: 0.8773 },
  },
  points: {
    meanAlpha: { p10: 0.1586, p50: 0.9376, p90: 0.9888 },
    solidFraction: { p10: 0.1234, p50: 0.9524, p90: 0.9948 },
  },
  polar: {
    meanAlpha: { p10: 0.5992, p50: 0.7711, p90: 0.8742 },
    solidFraction: { p10: 0.662, p50: 0.8204, p90: 0.9227 },
  },
  polymeter: {
    meanAlpha: { p10: 0.4533, p50: 0.5119, p90: 0.5491 },
    solidFraction: { p10: 0.4683, p50: 0.5049, p90: 0.5558 },
  },
  posterize: {
    meanAlpha: { p10: 0.497, p50: 0.7889, p90: 0.9013 },
    solidFraction: { p10: 0.5523, p50: 0.8264, p90: 0.9132 },
  },
  preSilenceBlack: {
    meanAlpha: { p10: 0.0694, p50: 0.1563, p90: 0.391 },
    solidFraction: { p10: 0.0, p50: 0.0, p90: 0.2026 },
  },
  projectorBlackLift: {
    meanAlpha: { p10: 0.5122, p50: 0.7789, p90: 0.8915 },
    solidFraction: { p10: 0.4988, p50: 0.8053, p90: 0.9136 },
  },
  pulse: {
    meanAlpha: { p10: 0.4934, p50: 0.7831, p90: 0.8946 },
    solidFraction: { p10: 0.5002, p50: 0.8076, p90: 0.9171 },
  },
  qilouShutter: {
    meanAlpha: { p10: 0.2015, p50: 0.4063, p90: 0.6039 },
    solidFraction: { p10: 0.1837, p50: 0.3997, p90: 0.6064 },
  },
  repeat: {
    meanAlpha: { p10: 0.48, p50: 0.7706, p90: 0.9316 },
    solidFraction: { p10: 0.4746, p50: 0.7982, p90: 0.9446 },
  },
  ripple: {
    meanAlpha: { p10: 0.5249, p50: 0.7853, p90: 0.8767 },
    solidFraction: { p10: 0.5523, p50: 0.8411, p90: 0.9321 },
  },
  riso: {
    meanAlpha: { p10: 0.7578, p50: 0.8949, p90: 0.9559 },
    solidFraction: { p10: 0.7735, p50: 0.9053, p90: 0.9663 },
  },
  roadStitch: {
    meanAlpha: { p10: 0.0043, p50: 0.0103, p90: 0.0181 },
    solidFraction: { p10: 0.004, p50: 0.0098, p90: 0.0175 },
  },
  scalerRinging: {
    meanAlpha: { p10: 0.5179, p50: 0.8085, p90: 0.8984 },
    solidFraction: { p10: 0.5136, p50: 0.8276, p90: 0.9166 },
  },
  scanSlip: {
    meanAlpha: { p10: 0.5008, p50: 0.7777, p90: 0.8941 },
    solidFraction: { p10: 0.5122, p50: 0.8056, p90: 0.9142 },
  },
  scooterSlipstream: {
    meanAlpha: { p10: 0.4946, p50: 0.7781, p90: 0.8973 },
    solidFraction: { p10: 0.502, p50: 0.805, p90: 0.9132 },
  },
  sdfBlob: {
    meanAlpha: { p10: 0.017, p50: 0.029, p90: 0.0588 },
    solidFraction: { p10: 0.0072, p50: 0.01, p90: 0.0178 },
  },
  sdfCube: {
    meanAlpha: { p10: 0.0503, p50: 0.1218, p90: 0.2212 },
    solidFraction: { p10: 0.0157, p50: 0.0372, p90: 0.1747 },
  },
  sdfLattice: {
    meanAlpha: { p10: 0.1914, p50: 0.2427, p90: 0.3239 },
    solidFraction: { p10: 0.0383, p50: 0.079, p90: 0.1785 },
  },
  sdfTunnel: {
    meanAlpha: { p10: 0.2574, p50: 0.3294, p90: 0.3466 },
    solidFraction: { p10: 0.0241, p50: 0.0512, p90: 0.0809 },
  },
  seaSalt: {
    meanAlpha: { p10: 0.481, p50: 0.6193, p90: 0.7702 },
    solidFraction: { p10: 0.4858, p50: 0.7429, p90: 0.8913 },
  },
  seigaiha: {
    meanAlpha: { p10: 0.4073, p50: 0.5414, p90: 0.8914 },
    solidFraction: { p10: 0.415, p50: 0.5546, p90: 0.9126 },
  },
  sleeperRail: {
    meanAlpha: { p10: 0.4945, p50: 0.7802, p90: 0.8958 },
    solidFraction: { p10: 0.4934, p50: 0.8083, p90: 0.9162 },
  },
  slice: {
    meanAlpha: { p10: 0.4949, p50: 0.7789, p90: 0.8961 },
    solidFraction: { p10: 0.5004, p50: 0.8071, p90: 0.9146 },
  },
  sodium: {
    meanAlpha: { p10: 0.3722, p50: 0.7359, p90: 0.947 },
    solidFraction: { p10: 0.3247, p50: 0.7561, p90: 0.949 },
  },
  spin: {
    meanAlpha: { p10: 0.5216, p50: 0.7731, p90: 0.8908 },
    solidFraction: { p10: 0.542, p50: 0.8074, p90: 0.9157 },
  },
  spiral: {
    meanAlpha: { p10: 0.1982, p50: 0.6023, p90: 0.9349 },
    solidFraction: { p10: 0.2119, p50: 0.6164, p90: 0.9463 },
  },
  stamp: {
    meanAlpha: { p10: 0.1764, p50: 0.2255, p90: 0.739 },
    solidFraction: { p10: 0.0, p50: 0.0, p90: 0.9524 },
  },
  stripes: {
    meanAlpha: { p10: 0.4579, p50: 0.5926, p90: 0.8271 },
    solidFraction: { p10: 0.5084, p50: 0.6429, p90: 0.8692 },
  },
  sunbleachedTarp: {
    meanAlpha: { p10: 0.4684, p50: 0.7287, p90: 0.8361 },
    solidFraction: { p10: 0.4802, p50: 0.794, p90: 0.9111 },
  },
  sunburst: {
    meanAlpha: { p10: 0.1536, p50: 0.4032, p90: 0.6611 },
    solidFraction: { p10: 0.1444, p50: 0.4014, p90: 0.6626 },
  },
  sway: {
    meanAlpha: { p10: 0.5081, p50: 0.7751, p90: 0.8865 },
    solidFraction: { p10: 0.5156, p50: 0.809, p90: 0.9148 },
  },
  tapeWow: {
    meanAlpha: { p10: 0.5029, p50: 0.7766, p90: 0.8904 },
    solidFraction: { p10: 0.5104, p50: 0.809, p90: 0.9148 },
  },
  templeZigzag: {
    meanAlpha: { p10: 0.0428, p50: 0.0855, p90: 0.1306 },
    solidFraction: { p10: 0.035, p50: 0.0731, p90: 0.1113 },
  },
  threshold: {
    meanAlpha: { p10: 0.668, p50: 0.7925, p90: 0.9139 },
    solidFraction: { p10: 0.654, p50: 0.8165, p90: 0.91 },
  },
  tiles: {
    meanAlpha: { p10: 0.265, p50: 0.3748, p90: 0.4323 },
    solidFraction: { p10: 0.2678, p50: 0.3617, p90: 0.4215 },
  },
  tunnelDraft: {
    meanAlpha: { p10: 0.5018, p50: 0.7811, p90: 0.8913 },
    solidFraction: { p10: 0.5215, p50: 0.8078, p90: 0.9179 },
  },
  typhoonShear: {
    meanAlpha: { p10: 0.5061, p50: 0.7778, p90: 0.8949 },
    solidFraction: { p10: 0.5148, p50: 0.8088, p90: 0.9168 },
  },
  uroko: {
    meanAlpha: { p10: 0.2656, p50: 0.3517, p90: 0.4429 },
    solidFraction: { p10: 0.1371, p50: 0.2085, p90: 0.284 },
  },
  viaductJoints: {
    meanAlpha: { p10: 0.0569, p50: 0.0681, p90: 0.0843 },
    solidFraction: { p10: 0.0495, p50: 0.0639, p90: 0.073 },
  },
  vortex: {
    meanAlpha: { p10: 0.5225, p50: 0.7795, p90: 0.8843 },
    solidFraction: { p10: 0.54, p50: 0.8137, p90: 0.9153 },
  },
  wetConcrete: {
    meanAlpha: { p10: 0.4936, p50: 0.7689, p90: 0.8842 },
    solidFraction: { p10: 0.4968, p50: 0.8042, p90: 0.9166 },
  },
  windows: {
    meanAlpha: { p10: 0.0524, p50: 0.136, p90: 0.3014 },
    solidFraction: { p10: 0.0526, p50: 0.1356, p90: 0.2859 },
  },
  wires: {
    meanAlpha: { p10: 0.0341, p50: 0.068, p90: 0.1492 },
    solidFraction: { p10: 0.034, p50: 0.0679, p90: 0.1493 },
  },
  xerox: {
    meanAlpha: { p10: 0.4787, p50: 0.7663, p90: 0.8702 },
    solidFraction: { p10: 0.4856, p50: 0.7797, p90: 0.8774 },
  },
};
