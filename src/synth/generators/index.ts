/**
 * 実装付きカタログ（InlineGeneratorCatalog）。
 * 検証・コスト計算だけなら ../catalog.ts の GeneratorCatalog（純粋なメタデータ層）で足りる。
 */
import type { GeneratorDefinition } from '../types';
import { asanohaGenerator } from './asanoha';
import { asphaltIridescenceGenerator } from './asphaltIridescence';
import { barcodeGenerator } from './barcode';
import { beatMoireGenerator } from './beatMoire';
import { bellowsHoseGenerator } from './bellowsHose';
import { bathroomGlazeGenerator } from './bathroomGlaze';
import { blueprintGenerator } from './blueprint';
import { branchGenerator } from './branch';
import { brakeLightRainGenerator } from './brakeLightRain';
import { busJacquardGenerator } from './busJacquard';
import { busPolarizationGenerator } from './busPolarization';
import { cassetteWindowGenerator } from './cassetteWindow';
import { causticsGenerator } from './caustics';
import { cdDiffractionGenerator } from './cdDiffraction';
import { cellsGenerator } from './cells';
import { chainlinkGenerator } from './chainlink';
import { checkerGenerator } from './checker';
import { cheapLedGenerator } from './cheapLed';
import { chladniGenerator } from './chladni';
import { concentricGenerator } from './concentric';
import { coneFieldGenerator } from './coneField';
import { contourGenerator } from './contour';
import { corruptSaveGenerator } from './corruptSave';
import { crossingParallaxGenerator } from './crossingParallax';
import { crtGenerator } from './crt';
import { dropoutGenerator } from './dropout';
import { fanGuardGenerator } from './fanGuard';
import { fireworksGenerator } from './fireworks';
import { flameColumnGenerator } from './flameColumn';
import { flowGenerator } from './flow';
import { fluorescentGenerator } from './fluorescent';
import { flyoverBeamsGenerator } from './flyoverBeams';
import { fractalPaperGenerator } from './fractalPaper';
import { freezerCyanGenerator } from './freezerCyan';
import { gammaGenerator } from './gamma';
import { gateGenerator } from './gate';
import { goldfoilGenerator } from './goldfoil';
import { grainGenerator } from './grain';
import { gridGenerator } from './grid';
import { grilleGenerator } from './grille';
import { halftoneGenerator } from './halftone';
import { harborBackwashGenerator } from './harborBackwash';
import { hatchingGenerator } from './hatching';
import { hexGridGenerator } from './hexGrid';
import { hillClimbGenerator } from './hillClimb';
import { humidGalvanizedGenerator } from './humidGalvanized';
import { humidityLensGenerator } from './humidityLens';
import { inkGenerator } from './ink';
import { interlaceCombGenerator } from './interlaceComb';
import { invertGenerator } from './invert';
import { kaleidoGenerator } from './kaleido';
import { karaokeLcdGenerator } from './karaokeLcd';
import { kumikoGenerator } from './kumiko';
import { lavaBlobsGenerator } from './lavaBlobs';
import { macroblockGenerator } from './macroblock';
import { minidvFadeGenerator } from './minidvFade';
import { mirrorGenerator } from './mirror';
import { misprintGenerator } from './misprint';
import { mooringRopeGenerator } from './mooringRope';
import { mosaicFlipGenerator } from './mosaicFlip';
import { neonGenerator } from './neon';
import { nicotineCeilingGenerator } from './nicotineCeiling';
import { nightMarketCurtainGenerator } from './nightMarketCurtain';
import { noiseGenerator } from './noise';
import { outlineGenerator } from './outline';
import { paCarpetGenerator } from './paCarpet';
import { pcbMazeGenerator } from './pcbMaze';
import { petalsGenerator } from './petals';
import { pixelateGenerator } from './pixelate';
import { pointsGenerator } from './points';
import { polarGenerator } from './polar';
import { polymeterGenerator } from './polymeter';
import { posterizeGenerator } from './posterize';
import { preSilenceBlackGenerator } from './preSilenceBlack';
import { projectorBlackLiftGenerator } from './projectorBlackLift';
import { pulseGenerator } from './pulse';
import { qilouShutterGenerator } from './qilouShutter';
import { repeatGenerator } from './repeat';
import { risoGenerator } from './riso';
import { rippleGenerator } from './ripple';
import { roadStitchGenerator } from './roadStitch';
import { scalerRingingGenerator } from './scalerRinging';
import { sdfBlobGenerator } from './sdfBlob';
import { sdfCubeGenerator } from './sdfCube';
import { sdfLatticeGenerator } from './sdfLattice';
import { sdfTunnelGenerator } from './sdfTunnel';
import { scanSlipGenerator } from './scanSlip';
import { scooterSlipstreamGenerator } from './scooterSlipstream';
import { seaSaltGenerator } from './seaSalt';
import { seigaihaGenerator } from './seigaiha';
import { selfSimilarZoomGenerator } from './selfSimilarZoom';
import { shockwaveGenerator } from './shockwave';
import { sleeperRailGenerator } from './sleeperRail';
import { sliceGenerator } from './slice';
import { sodiumGenerator } from './sodium';
import { spinGenerator } from './spin';
import { spiralGenerator } from './spiral';
import { stampGenerator } from './stamp';
import { stripesGenerator } from './stripes';
import { sunbleachedTarpGenerator } from './sunbleachedTarp';
import { sunburstGenerator } from './sunburst';
import { swayGenerator } from './sway';
import { tapeWowGenerator } from './tapeWow';
import { templeZigzagGenerator } from './templeZigzag';
import { thresholdGenerator } from './threshold';
import { tilesGenerator } from './tiles';
import { tunnelDraftGenerator } from './tunnelDraft';
import { typhoonShearGenerator } from './typhoonShear';
import { urokoGenerator } from './uroko';
import { viaductJointsGenerator } from './viaductJoints';
import { vortexGenerator } from './vortex';
import { wetConcreteGenerator } from './wetConcrete';
import { windowsGenerator } from './windows';
import { wiresGenerator } from './wires';
import { xeroxGenerator } from './xerox';
import type { InlineGenerator, InlineGeneratorCatalog } from './types';

export type { EmitContext, InlineGenerator, InlineGeneratorCatalog } from './types';
export { gridGenerator, gridDef } from './grid';
export { pointsGenerator, pointsDef } from './points';
export { branchGenerator, branchDef } from './branch';
export { cellsGenerator, cellsDef } from './cells';
export { tilesGenerator, tilesDef } from './tiles';
export { wiresGenerator, wiresDef } from './wires';
export { concentricGenerator, concentricDef } from './concentric';
export { grilleGenerator, grilleDef } from './grille';
export { stripesGenerator, stripesDef } from './stripes';
export { qilouShutterGenerator, qilouShutterDef } from './qilouShutter';
export { nightMarketCurtainGenerator, nightMarketCurtainDef } from './nightMarketCurtain';
export { roadStitchGenerator, roadStitchDef } from './roadStitch';
export { flyoverBeamsGenerator, flyoverBeamsDef } from './flyoverBeams';
export { fanGuardGenerator, fanGuardDef } from './fanGuard';
export { mooringRopeGenerator, mooringRopeDef } from './mooringRope';
export { viaductJointsGenerator, viaductJointsDef } from './viaductJoints';
export { busJacquardGenerator, busJacquardDef } from './busJacquard';
export { templeZigzagGenerator, templeZigzagDef } from './templeZigzag';
export { polymeterGenerator, polymeterDef } from './polymeter';
export { pcbMazeGenerator, pcbMazeDef } from './pcbMaze';
export { bellowsHoseGenerator, bellowsHoseDef } from './bellowsHose';
export { cassetteWindowGenerator, cassetteWindowDef } from './cassetteWindow';
export { seigaihaGenerator, seigaihaDef } from './seigaiha';
export { asanohaGenerator, asanohaDef } from './asanoha';
export { kumikoGenerator, kumikoDef } from './kumiko';
export { checkerGenerator, checkerDef } from './checker';
export { hexGridGenerator, hexGridDef } from './hexGrid';
export { contourGenerator, contourDef } from './contour';
export { sunburstGenerator, sunburstDef } from './sunburst';
export { spiralGenerator, spiralDef } from './spiral';
export { windowsGenerator, windowsDef } from './windows';
export { chainlinkGenerator, chainlinkDef } from './chainlink';
export { barcodeGenerator, barcodeDef } from './barcode';
export { petalsGenerator, petalsDef } from './petals';
export { urokoGenerator, urokoDef } from './uroko';
export { selfSimilarZoomGenerator, selfSimilarZoomDef } from './selfSimilarZoom';
export { chladniGenerator, chladniDef } from './chladni';
export { lavaBlobsGenerator, lavaBlobsDef } from './lavaBlobs';
export { causticsGenerator, causticsDef } from './caustics';
export { mosaicFlipGenerator, mosaicFlipDef } from './mosaicFlip';
export { fractalPaperGenerator, fractalPaperDef } from './fractalPaper';
export { fireworksGenerator, fireworksDef } from './fireworks';
export { flameColumnGenerator, flameColumnDef } from './flameColumn';
export { sdfTunnelGenerator, sdfTunnelDef } from './sdfTunnel';
export { sdfLatticeGenerator, sdfLatticeDef } from './sdfLattice';
export { sdfBlobGenerator, sdfBlobDef } from './sdfBlob';
export { sdfCubeGenerator, sdfCubeDef } from './sdfCube';
export { noiseGenerator, noiseDef } from './noise';
export { vortexGenerator, vortexDef } from './vortex';
export { flowGenerator, flowDef } from './flow';
export { rippleGenerator, rippleDef } from './ripple';
export { swayGenerator, swayDef } from './sway';
export { pulseGenerator, pulseDef } from './pulse';
export { typhoonShearGenerator, typhoonShearDef } from './typhoonShear';
export { tapeWowGenerator, tapeWowDef } from './tapeWow';
export { coneFieldGenerator, coneFieldDef } from './coneField';
export { humidityLensGenerator, humidityLensDef } from './humidityLens';
export { tunnelDraftGenerator, tunnelDraftDef } from './tunnelDraft';
export { hillClimbGenerator, hillClimbDef } from './hillClimb';
export { harborBackwashGenerator, harborBackwashDef } from './harborBackwash';
export { sleeperRailGenerator, sleeperRailDef } from './sleeperRail';
export { scooterSlipstreamGenerator, scooterSlipstreamDef } from './scooterSlipstream';
export { crossingParallaxGenerator, crossingParallaxDef } from './crossingParallax';
export { shockwaveGenerator, shockwaveDef } from './shockwave';
export { mirrorGenerator, mirrorDef } from './mirror';
export { repeatGenerator, repeatDef } from './repeat';
export { pixelateGenerator, pixelateDef } from './pixelate';
export { thresholdGenerator, thresholdDef } from './threshold';
export { dropoutGenerator, dropoutDef } from './dropout';
export { kaleidoGenerator, kaleidoDef } from './kaleido';
export { sliceGenerator, sliceDef } from './slice';
export { posterizeGenerator, posterizeDef } from './posterize';
export { invertGenerator, invertDef } from './invert';
export { macroblockGenerator, macroblockDef } from './macroblock';
export { corruptSaveGenerator, corruptSaveDef } from './corruptSave';
export { beatMoireGenerator, beatMoireDef } from './beatMoire';
export { scanSlipGenerator, scanSlipDef } from './scanSlip';
export { polarGenerator, polarDef } from './polar';
export { spinGenerator, spinDef } from './spin';
export { xeroxGenerator, xeroxDef } from './xerox';
export { scalerRingingGenerator, scalerRingingDef } from './scalerRinging';
export { interlaceCombGenerator, interlaceCombDef } from './interlaceComb';
export { halftoneGenerator, halftoneDef } from './halftone';
export { outlineGenerator, outlineDef } from './outline';
export { gateGenerator, gateDef } from './gate';
export { gammaGenerator, gammaDef } from './gamma';
export { grainGenerator, grainDef } from './grain';
export { neonGenerator, neonDef } from './neon';
export { inkGenerator, inkDef } from './ink';
export { crtGenerator, crtDef } from './crt';
export { cheapLedGenerator, cheapLedDef } from './cheapLed';
export { fluorescentGenerator, fluorescentDef } from './fluorescent';
export { wetConcreteGenerator, wetConcreteDef } from './wetConcrete';
export { misprintGenerator, misprintDef } from './misprint';
export { sodiumGenerator, sodiumDef } from './sodium';
export { brakeLightRainGenerator, brakeLightRainDef } from './brakeLightRain';
export { freezerCyanGenerator, freezerCyanDef } from './freezerCyan';
export { minidvFadeGenerator, minidvFadeDef } from './minidvFade';
export { busPolarizationGenerator, busPolarizationDef } from './busPolarization';
export { asphaltIridescenceGenerator, asphaltIridescenceDef } from './asphaltIridescence';
export { paCarpetGenerator, paCarpetDef } from './paCarpet';
export { humidGalvanizedGenerator, humidGalvanizedDef } from './humidGalvanized';
export { bathroomGlazeGenerator, bathroomGlazeDef } from './bathroomGlaze';
export { projectorBlackLiftGenerator, projectorBlackLiftDef } from './projectorBlackLift';
export { nicotineCeilingGenerator, nicotineCeilingDef } from './nicotineCeiling';
export { karaokeLcdGenerator, karaokeLcdDef } from './karaokeLcd';
export { cdDiffractionGenerator, cdDiffractionDef } from './cdDiffraction';
export { preSilenceBlackGenerator, preSilenceBlackDef } from './preSilenceBlack';
export { seaSaltGenerator, seaSaltDef } from './seaSalt';
export { sunbleachedTarpGenerator, sunbleachedTarpDef } from './sunbleachedTarp';
export { risoGenerator, risoDef } from './riso';
export { blueprintGenerator, blueprintDef } from './blueprint';
export { goldfoilGenerator, goldfoilDef } from './goldfoil';
export { hatchingGenerator, hatchingDef } from './hatching';
export { stampGenerator, stampDef } from './stamp';

const ALL: InlineGenerator[] = [
  // sources
  gridGenerator,
  pointsGenerator,
  branchGenerator,
  cellsGenerator,
  tilesGenerator,
  wiresGenerator,
  concentricGenerator,
  grilleGenerator,
  stripesGenerator,
  qilouShutterGenerator,
  nightMarketCurtainGenerator,
  roadStitchGenerator,
  flyoverBeamsGenerator,
  fanGuardGenerator,
  mooringRopeGenerator,
  viaductJointsGenerator,
  busJacquardGenerator,
  templeZigzagGenerator,
  polymeterGenerator,
  pcbMazeGenerator,
  bellowsHoseGenerator,
  cassetteWindowGenerator,
  seigaihaGenerator,
  asanohaGenerator,
  kumikoGenerator,
  checkerGenerator,
  hexGridGenerator,
  contourGenerator,
  sunburstGenerator,
  spiralGenerator,
  windowsGenerator,
  chainlinkGenerator,
  barcodeGenerator,
  petalsGenerator,
  urokoGenerator,
  selfSimilarZoomGenerator,
  chladniGenerator,
  lavaBlobsGenerator,
  causticsGenerator,
  mosaicFlipGenerator,
  fractalPaperGenerator,
  fireworksGenerator,
  flameColumnGenerator,
  // 3D (SDF レイマーチ) source — costClass: heavy。low tier では derive の候補から
  // 外れる（derive.ts の fitsBudgetAlone）。
  sdfTunnelGenerator,
  sdfLatticeGenerator,
  sdfBlobGenerator,
  sdfCubeGenerator,
  // 画像入力を持つ source（seed ガチャの対象外 — derive.ts が textures 持ちを除外する）
  stampGenerator,
  // fields
  noiseGenerator,
  vortexGenerator,
  flowGenerator,
  rippleGenerator,
  swayGenerator,
  pulseGenerator,
  typhoonShearGenerator,
  tapeWowGenerator,
  coneFieldGenerator,
  humidityLensGenerator,
  tunnelDraftGenerator,
  hillClimbGenerator,
  harborBackwashGenerator,
  sleeperRailGenerator,
  scooterSlipstreamGenerator,
  crossingParallaxGenerator,
  shockwaveGenerator,
  // modifiers (coord + value)
  mirrorGenerator,
  repeatGenerator,
  pixelateGenerator,
  thresholdGenerator,
  dropoutGenerator,
  kaleidoGenerator,
  sliceGenerator,
  posterizeGenerator,
  invertGenerator,
  macroblockGenerator,
  corruptSaveGenerator,
  beatMoireGenerator,
  scanSlipGenerator,
  polarGenerator,
  spinGenerator,
  xeroxGenerator,
  scalerRingingGenerator,
  interlaceCombGenerator,
  halftoneGenerator,
  outlineGenerator,
  gateGenerator,
  gammaGenerator,
  grainGenerator,
  // materials
  neonGenerator,
  inkGenerator,
  crtGenerator,
  cheapLedGenerator,
  fluorescentGenerator,
  wetConcreteGenerator,
  misprintGenerator,
  sodiumGenerator,
  brakeLightRainGenerator,
  freezerCyanGenerator,
  minidvFadeGenerator,
  busPolarizationGenerator,
  asphaltIridescenceGenerator,
  paCarpetGenerator,
  humidGalvanizedGenerator,
  bathroomGlazeGenerator,
  projectorBlackLiftGenerator,
  nicotineCeilingGenerator,
  karaokeLcdGenerator,
  cdDiffractionGenerator,
  preSilenceBlackGenerator,
  seaSaltGenerator,
  sunbleachedTarpGenerator,
  risoGenerator,
  blueprintGenerator,
  goldfoilGenerator,
  hatchingGenerator,
];

/** Built-in inline generator catalog (Phase 1 generators). */
export function createInlineCatalog(gens: InlineGenerator[] = ALL): InlineGeneratorCatalog {
  const byId = new Map<string, InlineGenerator>();
  for (const g of gens) {
    byId.set(g.def.id, g);
  }
  return {
    get(id: string): InlineGenerator | undefined {
      return byId.get(id);
    },
    all(): InlineGenerator[] {
      return Array.from(byId.values());
    },
  };
}

export const inlineCatalog: InlineGeneratorCatalog = createInlineCatalog();

/** GeneratorDefinition list for cost/validate integration. */
export function allGeneratorDefinitions(): GeneratorDefinition[] {
  return inlineCatalog.all().map((g) => g.def);
}
