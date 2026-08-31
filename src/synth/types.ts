export type GeneratorCategory = 'source' | 'field' | 'modifier' | 'material';
export type CostClass = 'micro' | 'light' | 'medium' | 'heavy';
/** inline: GLSL 関数として融合 / pass: 独立した FBO パス */
export type GeneratorImpl = 'inline' | 'pass';
/** Generator の出力型。inline は field/vector/color、pass は texture。 */
export type PortType = 'field' | 'vector' | 'color' | 'texture';

export interface GeneratorTags {
  environment?: string[];
  culturalTexture?: string[];
  material?: string[];
  motion?: string[];
  affect?: string[];
}

export type ParameterKind = 'number' | 'int' | 'bool' | 'enum';

export interface ParameterDefinition {
  id: string;
  label: string;
  kind: ParameterKind;
  /** number / int のとき必須 */
  min?: number;
  max?: number;
  /** enum のとき必須 */
  options?: string[];
  default: number | string | boolean;
  /** Modulation Route の target になれるか */
  modulatable: boolean;
}

export interface GeneratorCost {
  /** この Generator が要求する描画パス数。inline は 0。 */
  passes: number;
  /** フルスクリーン1パスを 1.0 としたときの相対フィルレート負荷。 */
  relativeFill: number;
  /** 前フレームの状態を持つか（粒子・流体・フィードバック）。 */
  stateful: boolean;
}

export interface GeneratorDefinition {
  id: string;
  version: number;
  category: GeneratorCategory;
  costClass: CostClass;
  impl: GeneratorImpl;
  output: PortType;
  tags: GeneratorTags;
  parameters: ParameterDefinition[];
  cost: GeneratorCost;
  /**
   * 入力テクスチャのスロット名。宣言した Generator は、スロットごとに
   * `sampler2D` とその実サイズ `vec2` の uniform を受け取る（assemble.ts が
   * 宣言を出し、シーンが Patch の images 参照を解決してバインドする）。
   *
   * Phase 0 で予約した PortType 'texture' の、入力側としての実体。impl が
   * inline / pass のどちらでも同じ宣言でよい（pass Generator のフィードバック
   * 入力も同じスロット機構に乗る）。省略した Generator はテクスチャを一切
   * 受け取らない = 既存の Generator はすべて不変。
   */
  textures?: string[];
}

export interface VisualOperator {
  /** Patch 内で一意 */
  id: string;
  generatorId: string;
  generatorVersion: number;
  parameters: Record<string, number | string | boolean>;
}

export type ModulationPolarity = 'unipolar' | 'bipolar';

export interface ModulationRoute {
  /** "audio:bass" | "audio:mid" | "audio:treble" | "audio:level" | "audio:beat"
   *  | "audio:barPhase" | "audio:beatPhase" | "time" | "operator:<opId>" */
  source: string;
  /** "<opId>.<paramId>" */
  target: string;
  amount: number;
  polarity: ModulationPolarity;
  /** 平滑化の時定数（秒）。 */
  smoothing: number;
}

export type PaletteMode = 'mono' | 'analogous' | 'complementary' | 'triadic' | 'rainbow';

export interface PaletteSpec {
  mode: PaletteMode;
  hueOffset: number; // 0..360
  saturation: number; // 0..100
  lightness: number; // 0..100
}

export interface CompositionSpec {
  /** 対称・繰り返し数 */
  symmetry: number;
  /** 全体スケール */
  scale: number;
  /** 全体の動きの速さ */
  speed: number;
}

export type QualityTier = 'low' | 'medium' | 'high';

/**
 * Patch が参照する画像。ピクセルは持たず、名前とコンテンツハッシュだけを保存する
 * （Semantic Replay の契約: 同じ画像が手元にあれば同じ Look、無ければ v=0）。
 */
export interface ImageRef {
  name: string;
  /** SHA-256 hex（元バイト列のハッシュ）。 */
  hash: string;
}

export interface VisualPatch {
  schemaVersion: number;
  seed: string;
  operators: VisualOperator[];
  routes: ModulationRoute[];
  palette: PaletteSpec;
  composition: CompositionSpec;
  qualityTier: QualityTier;
  /**
   * テクスチャスロットへの画像割り当て。キーは `<opId>.<slot>`。
   * 任意フィールドなので、テクスチャを使わない Patch は今までどおり省略する。
   */
  images?: Record<string, ImageRef>;
}

export interface RenderBudget {
  maxCost: number;
  maxPasses: number;
  maxHeavyGenerators: number;
  maxStatefulGenerators: number;
}

export type TransitionEasing = 'linear' | 'easeInOut';

export interface TransitionSpec {
  /** palette (hue/saturation/lightness) の遷移時間 ms */
  paletteMs: number;
  /** 数値パラメータの遷移時間 ms */
  parameterMs: number;
  /** ModulationRoute の amount の遷移時間 ms */
  modulationMs: number;
  /** トポロジ変更時のデッキクロスフェード時間 ms */
  topologyMs: number;
  easing: TransitionEasing;
}

export const DEFAULT_TRANSITION: TransitionSpec = {
  paletteMs: 1200,
  parameterMs: 800,
  modulationMs: 1000,
  topologyMs: 2000,
  easing: 'easeInOut',
};

export type TransitionPresetId = 'default' | 'slow' | 'cut';

/** default = DEFAULT_TRANSITION / slow = 各 ms ×2 / cut = 全 120ms。easing は共通。 */
export const TRANSITION_PRESETS: Record<TransitionPresetId, TransitionSpec> = {
  default: DEFAULT_TRANSITION,
  slow: {
    paletteMs: DEFAULT_TRANSITION.paletteMs * 2,
    parameterMs: DEFAULT_TRANSITION.parameterMs * 2,
    modulationMs: DEFAULT_TRANSITION.modulationMs * 2,
    topologyMs: DEFAULT_TRANSITION.topologyMs * 2,
    easing: DEFAULT_TRANSITION.easing,
  },
  cut: {
    paletteMs: 120,
    parameterMs: 120,
    modulationMs: 120,
    topologyMs: 120,
    easing: DEFAULT_TRANSITION.easing,
  },
};
