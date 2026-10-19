import { symbolLibrary } from '../../runtime.mjs';
/** Confirmed local symbol data used by the two example modules. */
export const parts = {
  resistor: {
    libraryPath: symbolLibrary('Device'),
    libId: 'Device:R',
    pins: { top: '1', bottom: '2' },
  },
};
