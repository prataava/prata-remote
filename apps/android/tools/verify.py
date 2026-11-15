#!/usr/bin/env python3
"""Verifikasi statis proyek Android PRATA Remote (Command 002, Tugas 2-3).

Memeriksa tanpa Gradle (yang butuh unduhan + daemon):
  1. Semua file .xml ter-parse sebagai XML.
  2. Keseimbangan kurung {} () [] tiap file .kt (lewati string & komentar).
  3. Setiap import com.prata.remote.* merujuk file .kt yang benar-benar ada.
  4. Setiap kelas yang dirujuk AndroidManifest (Activity/Service) ada filenya.
  5. Tidak ada penanda gimmick (TODO/FIXME/stub palsu) di kode aplikasi.
  6. File wajib tiap modul ada (build.gradle.kts, manifest, MainActivity).
Jalankan:  python3 apps/android/tools/verify.py
Keluar 0 bila semua lolos, 1 bila ada kegagalan.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAILURES: list[str] = []
PASSES: list[str] = []


def ok(name: str) -> None:
    PASSES.append(name)
    print(f"LULUS  {name}")


def fail(name: str, detail: str = "") -> None:
    FAILURES.append(name)
    print(f"GAGAL  {name}" + (f" :: {detail}" if detail else ""))


def strip_kotlin(text: str) -> str:
    """Hapus string literal, raw string, dan komentar agar cek kurung jujur."""
    out = []
    i, n = 0, len(text)
    while i < n:
        if text.startswith('"""', i):
            end = text.find('"""', i + 3)
            i = n if end == -1 else end + 3
            out.append('""')
        elif text[i] == '"':
            j = i + 1
            while j < n and text[j] != '"':
                if text[j] == "\\":
                    j += 1
                j += 1
            i = min(j + 1, n)
            out.append('""')
        elif text[i] == "'":
            j = i + 1
            while j < n and text[j] != "'":
                if text[j] == "\\":
                    j += 1
                j += 1
            i = min(j + 1, n)
            out.append("''")
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def check_braces(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    code = strip_kotlin(text)
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack: list[tuple[str, int]] = []
    for idx, ch in enumerate(code):
        if ch in pairs:
            stack.append((ch, idx))
        elif ch in pairs.values():
            if not stack:
                fail(f"kurung {path.relative_to(ROOT)}", f"tutup '{ch}' tanpa buka di offset {idx}")
                return
            opener, _ = stack.pop()
            if pairs[opener] != ch:
                fail(f"kurung {path.relative_to(ROOT)}", f"'{opener}' ditutup '{ch}' di offset {idx}")
                return
    if stack:
        opener, idx = stack[-1]
        fail(f"kurung {path.relative_to(ROOT)}", f"'{opener}' tidak tertutup (offset {idx})")
        return
    ok(f"kurung {path.relative_to(ROOT)}")


def check_xml(path: Path) -> None:
    try:
        ET.parse(path)
        ok(f"xml {path.relative_to(ROOT)}")
    except ET.ParseError as e:
        fail(f"xml {path.relative_to(ROOT)}", str(e))


def collect_kotlin_classes() -> set[str]:
    """Kumpulkan simbol tingkat atas per paket: kelas/objek/interface DAN
    fungsi tingkat atas (layar @Composable adalah fungsi, bukan kelas)."""
    symbols = set()
    for kt in ROOT.rglob("*.kt"):
        text = kt.read_text(encoding="utf-8")
        pkg = re.search(r"^package\s+([\w.]+)", text, re.M)
        if not pkg:
            continue
        for m in re.finditer(r"\b(?:class|object|interface)\s+(\w+)", text):
            symbols.add(f"{pkg.group(1)}.{m.group(1)}")
        for m in re.finditer(r"^fun\s+(\w+)", text, re.M):
            symbols.add(f"{pkg.group(1)}.{m.group(1)}")
    return symbols


def check_imports(classes: set[str]) -> None:
    missing: list[str] = []
    for kt in sorted(ROOT.rglob("*.kt")):
        text = kt.read_text(encoding="utf-8")
        for imp in re.findall(r"^import\s+([\w.]+)", text, re.M):
            if not imp.startswith("com.prata.remote."):
                continue
            if imp in classes:
                continue
            # Import bisa merujuk anggota (fungsi/properti) di dalam file,
            # bukan kelas: izinkan bila paket file-nya ada.
            pkg = imp.rsplit(".", 1)[0]
            if any(c.startswith(pkg + ".") for c in classes):
                continue
            missing.append(f"{kt.relative_to(ROOT)}: {imp}")
    if missing:
        fail("import com.prata.remote.*", "; ".join(missing[:5]))
    else:
        ok("import com.prata.remote.* terpecahkan")


def check_manifest_classes(classes: set[str]) -> None:
    missing: list[str] = []
    for manifest in ROOT.rglob("AndroidManifest.xml"):
        tree = ET.parse(manifest)
        ns = "{http://schemas.android.com/apk/res/android}"
        for elem in tree.getroot().iter():
            name = elem.get(f"{ns}name")
            if not name or not name.startswith("."):
                continue
            # Cari modul pemilik manifest untuk namespace-nya:
            # AndroidManifest.xml ada di <modul>/src/main/ -> parents[2] = modul.
            module_dir = manifest.parents[2]
            gradle = module_dir / "build.gradle.kts"
            namespace = ""
            if gradle.exists():
                m = re.search(r'namespace\s*=\s*"([^"]+)"', gradle.read_text(encoding="utf-8"))
                namespace = m.group(1) if m else ""
            fqcn = namespace + name
            if fqcn not in classes:
                missing.append(f"{manifest.relative_to(ROOT)}: {fqcn}")
    if missing:
        fail("kelas di AndroidManifest", "; ".join(missing))
    else:
        ok("kelas di AndroidManifest ada")


def check_required_files() -> None:
    required = [
        "settings.gradle.kts",
        "build.gradle.kts",
        "gradle.properties",
        "gradle/wrapper/gradle-wrapper.properties",
        "shared/build.gradle.kts",
        "shared/src/main/AndroidManifest.xml",
        "shared/src/main/java/com/prata/remote/shared/model/RtcModels.kt",
        "shared/src/main/java/com/prata/remote/shared/model/DeviceMetrics.kt",
        "shared/src/main/java/com/prata/remote/shared/model/Files.kt",
        "shared/src/main/java/com/prata/remote/shared/model/Apps.kt",
        "shared/src/main/java/com/prata/remote/shared/webrtc/WebRtcClient.kt",
        "agent/build.gradle.kts",
        "agent/src/main/AndroidManifest.xml",
        "agent/src/main/java/com/prata/remote/agent/MainActivity.kt",
        "agent/src/main/java/com/prata/remote/agent/AgentViewModel.kt",
        "agent/src/main/java/com/prata/remote/agent/service/AgentForegroundService.kt",
        "agent/src/main/java/com/prata/remote/agent/service/MediaProjectionHolder.kt",
        "agent/src/main/java/com/prata/remote/agent/service/PrataAccessibilityService.kt",
        "agent/src/main/java/com/prata/remote/agent/service/AccessibilityController.kt",
        "agent/src/main/java/com/prata/remote/agent/service/DeviceMetricsCollector.kt",
        "agent/src/main/java/com/prata/remote/agent/service/AgentMetricsBridge.kt",
        "agent/src/main/java/com/prata/remote/agent/service/SafFolderStore.kt",
        "agent/src/main/java/com/prata/remote/agent/service/FileBrowser.kt",
        "agent/src/main/java/com/prata/remote/agent/service/AppManager.kt",
        "agent/src/main/java/com/prata/remote/agent/service/PrataNotificationListenerService.kt",
        "agent/src/main/res/xml/accessibility_service_config.xml",
        "agent/src/main/res/values/strings.xml",
        "agent/src/main/java/com/prata/remote/agent/ui/UnpairedScreen.kt",
        "agent/src/main/java/com/prata/remote/agent/ui/PairedScreen.kt",
        "agent/src/main/java/com/prata/remote/agent/ui/PrataTheme.kt",
        "agent/src/main/java/com/prata/remote/agent/util/QrBitmap.kt",
        "controller/build.gradle.kts",
        "controller/src/main/AndroidManifest.xml",
        "controller/src/main/java/com/prata/remote/controller/MainActivity.kt",
        "controller/src/main/java/com/prata/remote/controller/RemoteControlViewModel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/RemoteControlScreen.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/MonitorPanel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/FilesPanel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/AppsPanel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/NotificationsPanel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/LockScreen.kt",
        "controller/src/main/java/com/prata/remote/controller/security/AppLock.kt",
        "controller/src/main/java/com/prata/remote/controller/LoginViewModel.kt",
        "controller/src/main/java/com/prata/remote/controller/DevicesViewModel.kt",
        "controller/src/main/java/com/prata/remote/controller/ScannerViewModel.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/LoginScreen.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/DeviceListScreen.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/QrScannerScreen.kt",
        "controller/src/main/java/com/prata/remote/controller/ui/PrataTheme.kt",
    ]
    missing = [f for f in required if not (ROOT / f).exists()]
    if missing:
        fail("file wajib", "; ".join(missing))
    else:
        ok(f"file wajib ({len(required)} file)")


def check_no_gimmick() -> None:
    bad: list[str] = []
    patterns = [r"\bTODO\b", r"\bFIXME\b", r"not yet implemented", r"placeholder"]
    for kt in sorted(ROOT.rglob("*.kt")):
        if "tools" in kt.parts:
            continue
        text = kt.read_text(encoding="utf-8")
        for pat in patterns:
            if re.search(pat, text):
                bad.append(f"{kt.relative_to(ROOT)}: {pat}")
    if bad:
        fail("tanpa penanda gimmick", "; ".join(bad[:5]))
    else:
        ok("tanpa penanda gimmick (TODO/FIXME/placeholder)")


def check_gradle_basics() -> None:
    checks = [
        ("settings.gradle.kts", [":shared", ":agent", ":controller"]),
        ("agent/build.gradle.kts", ["com.prata.remote.agent", "compose-bom", "zxing", "project(\":shared\")", "documentfile"]),
        ("controller/build.gradle.kts", ["com.prata.remote.controller", "camera", "barcode-scanning", "project(\":shared\")", "biometric", "fragment-ktx"]),
        ("shared/build.gradle.kts", ["retrofit", "okhttp", "security-crypto", "google-webrtc"]),
    ]
    for rel, needles in checks:
        path = ROOT / rel
        if not path.exists():
            fail(f"gradle {rel}", "file tidak ada")
            continue
        text = path.read_text(encoding="utf-8")
        absent = [n for n in needles if n not in text]
        if absent:
            fail(f"gradle {rel}", f"hilang: {', '.join(absent)}")
        else:
            ok(f"gradle {rel}")


def check_deep_verify() -> None:
    """Jalankan deep_verify.py (analisis lintas-berkas Kotlin) sebagai satu
    cek agregat — gagal bila analyzer menemukan satu pun kesalahan."""
    import subprocess

    deep = Path(__file__).resolve().parent / "deep_verify.py"
    try:
        proc = subprocess.run(
            [sys.executable, str(deep)],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:  # noqa: BLE001
        fail("deep_verify", f"tidak bisa dijalankan: {e}")
        return
    tail = (proc.stdout + proc.stderr).strip().splitlines()
    summary = next((ln for ln in tail if ln.startswith("RINGKASAN DEEP VERIFY")), "")
    if proc.returncode == 0 and "0 gagal" in summary:
        ok(f"deep_verify ({summary})")
    else:
        for ln in tail:
            if ln.strip().startswith("FAIL "):
                print(f"    deep: {ln.strip()}")
        fail("deep_verify", summary or f"exit {proc.returncode}")


def main() -> int:
    check_required_files()
    check_gradle_basics()
    for xml in sorted(ROOT.rglob("*.xml")):
        check_xml(xml)
    for kt in sorted(ROOT.rglob("*.kt")):
        check_braces(kt)
    classes = collect_kotlin_classes()
    check_imports(classes)
    check_manifest_classes(classes)
    check_no_gimmick()
    check_deep_verify()
    print(f"\nRINGKASAN verify: {len(PASSES)} lulus, {len(FAILURES)} gagal")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
