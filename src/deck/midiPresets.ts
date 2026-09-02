/**
 * KORG nanoPAD2 工場出荷 Scene 1 相当の固定マップ。
 *
 * Confirmation: unverified factory Scene 1 from issue 59; override via learn.
 * Date/method: 2026-09-02, remembered GM drums on MIDI ch 1 (index 0) from
 * issue #59 — not verified on hardware in this change.
 *
 * 下段 37,39,41,43,45,47,49,51 → slot 0..7（選択中 preset）
 * 上段 36,38,40,42,44,46,48,50 → slot 0..7 cut
 * pad 1 = 上段左 = note 36。X-Y は未割り当て。
 */
import type { MidiMapping } from './midi';

export const NANOPAD2_PAD1_NOTE = 36;

const LOWER_NOTES = [37, 39, 41, 43, 45, 47, 49, 51] as const;
const UPPER_NOTES = [36, 38, 40, 42, 44, 46, 48, 50] as const;

export const NANOPAD2_FACTORY_SCENE1: MidiMapping = {
  version: 1,
  name: 'nanoPAD2 Scene 1',
  bindings: [
    ...LOWER_NOTES.map((note, slot) => ({
      trigger: { kind: 'note' as const, ch: 0, note },
      action: { type: 'trigger' as const, slot },
    })),
    ...UPPER_NOTES.map((note, slot) => ({
      trigger: { kind: 'note' as const, ch: 0, note },
      action: { type: 'trigger' as const, slot, cut: true },
    })),
  ],
};
