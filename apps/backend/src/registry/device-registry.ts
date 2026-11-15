// PRATA Remote — Registry perangkat (Command 001, Phase 1)
// Kontrak verifikasi token agen + kepemilikan perangkat.
// Implementasi yang dipakai dipilih lewat env DEVICE_REGISTRY:
// - "env"    -> EnvDeviceRegistry (pengembangan; token dari PRATA_AGENT_TOKENS)
// - "prisma" -> PrismaDeviceRegistry (produksi; baca tabel devices)
export interface DeviceRegistry {
  /** true bila token cocok dengan agentTokenHash perangkat itu. */
  verifyAgentToken(deviceId: string, token: string): Promise<boolean>;
  /** id pemilik perangkat, atau null bila perangkat tidak dikenal. */
  getOwner(deviceId: string): Promise<string | null>;
}
