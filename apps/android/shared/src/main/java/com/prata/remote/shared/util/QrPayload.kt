package com.prata.remote.shared.util

// PRATA Remote — Parser payload QR pairing (Command 002, Tugas 2-3)
// Format QR yang dihasilkan backend: prata://pair/<pairingId>/<kode>
// (lihat PairingService.buildQrPayload). Kode dinormalisasi ke huruf besar.
object QrPayload {
    data class PairingCode(val pairingId: String, val code: String)

    private val PATTERN = Regex("^prata://pair/([A-Za-z0-9_-]+)/([A-Za-z0-9]+)$")

    fun parse(raw: String): PairingCode? {
        val match = PATTERN.matchEntire(raw.trim()) ?: return null
        return PairingCode(pairingId = match.groupValues[1], code = match.groupValues[2].uppercase())
    }

    fun isPairingQr(raw: String): Boolean = parse(raw) != null
}
