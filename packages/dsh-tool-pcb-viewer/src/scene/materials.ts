// Shared PBR materials (tuned for a premium, realistic PCB look).
import * as THREE from 'three'
import { makeMaskGrainTexture } from './textures.js'

const grain = makeMaskGrainTexture()

export const M = {
  fr4: new THREE.MeshStandardMaterial({ color: 0xdccaa0, roughness: 0.82, metalness: 0.0 }),
  black: new THREE.MeshPhysicalMaterial({ color: 0x191a1e, roughness: 0.45, metalness: 0.06, clearcoat: 0.45, clearcoatRoughness: 0.35 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xe0b84e, metalness: 1.0, roughness: 0.22 }),
  silver: new THREE.MeshPhysicalMaterial({ color: 0xd2d8df, metalness: 1.0, roughness: 0.26, anisotropy: 0.5 }),
  shield: new THREE.MeshPhysicalMaterial({ color: 0xbcc1c7, metalness: 0.96, roughness: 0.32, anisotropy: 0.35 }),
  modGreen: new THREE.MeshStandardMaterial({ color: 0x15271b, roughness: 0.72 }),
  tan: new THREE.MeshStandardMaterial({ color: 0xa68f5a, roughness: 0.5 }),
  blueCap: new THREE.MeshPhysicalMaterial({ color: 0x3950b4, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
  amber: new THREE.MeshStandardMaterial({ color: 0xffb300, emissive: 0xff9500, emissiveIntensity: 0.6, roughness: 0.35 }),
  darkGray: new THREE.MeshPhysicalMaterial({ color: 0x2d3036, roughness: 0.52, metalness: 0.18, clearcoat: 0.22, clearcoatRoughness: 0.45 }),
  via: new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.9, roughness: 0.35, transparent: true, opacity: 1 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe9e7df, roughness: 0.55 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8b9199, metalness: 0.9, roughness: 0.45 }),
}

export { grain }
