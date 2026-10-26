/** Same MCU layout with a verified external passive crystal and load capacitors. */
import { place as placeMinimum } from './mcu-minimum.mjs';
export function place(options) {
  if (options.externalCrystalConfirmed !== true) throw new Error('Confirm external passive crystal mode and load-capacitor requirements');
  return placeMinimum(options);
}
