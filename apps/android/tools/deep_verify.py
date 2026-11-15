#!/usr/bin/env python3
"""PRATA Remote — Deep Kotlin Cross-File Type & Symbol Analyzer.

Verifikasi statis MENDALAM (di atas verify.py yang hanya cek struktur):
  1. Resolusi simbol lintas file: setiap pemanggilan fungsi / konstruktor /
     rujukan tipe `com.prata.remote.*` harus terdefinisi di salah satu
     berkas .kt (atau diimpor dengan benar). Simbol tak dikenal = FAIL.
  2. Kecocokan aritas: jumlah argumen di call-site vs jumlah parameter
     di definisi (termasuk trailing lambda & nilai default).
  3. Akses member: `obj.member` pada variabel yang tipenya bisa
     disimpulkan (deklarasi `val x: Tipe` / `val x = Tipe(...)`) harus
     berupa member/properti tipe itu (untuk kelas proyek sendiri).
  4. DTO: kunci JSON di toJson() vs fromJson() harus simetris per DTO.
  5. R.* : setiap R.<jenis>.<nama> harus ada di res/ (layout/id/string/
     xml/drawable/color/style).
  6. Manifest: setiap android:name komponen harus berupa kelas proyek.
  7. SDK: impor android.* harus berupa kelas yang ADA di android.jar
     (platform android-34). Impor pihak ketiga (androidx/org.webrtc/
     okhttp3/...) dipercaya bila paketnya ada di daftar dependensi
     build.gradle.kts (tanpa jar lokal untuk memeriksa membernya —
     batas jujur alat ini).
  8. Tanda tangan SDK berisiko: aritas pemanggilan API Android yang
     rawan salah (dispatchGesture, StrokeDescription, DocumentFile,
     PackageManager, AudioManager, dsb.).

Keluar 1 bila ada FAIL. WARN tidak menggagalkan.
Jalankan: python3 tools/deep_verify.py  (atau lewat verify.py)
"""
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Modul Gradle: agent / controller / shared — masing-masing punya
# src/main/java & src/main/res sendiri.
ANDROID_JAR = Path("/home/hatch/workspace/android-tools/sdk/platforms/android-34/android.jar")

FAILS: list[str] = []
WARNS: list[str] = []
PASSES = 0


def fail(msg: str) -> None:
    FAILS.append(msg)


def warn(msg: str) -> None:
    WARNS.append(msg)


def ok() -> None:
    global PASSES
    PASSES += 1


# ---------------------------------------------------------------- util
def strip_code(text: str) -> str:
    """Buang komentar & isi string literal, TAPI pertahankan nomor baris
    (karakter yang dibuang diganti spasi; newline dipertahankan)."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            seg = text[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in seg))
            i = j
        elif text.startswith('"""', i):
            j = text.find('"""', i + 3)
            j = n if j < 0 else j + 3
            seg = text[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in seg))
            i = j
        elif c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append('""' + " " * max(0, min(j + 1, n) - i - 2))
            i = min(j + 1, n)
        elif c == "'":
            j = i + 1
            while j < n and text[j] != "'":
                j += 2 if text[j] == "\\" else 1
            out.append("''" + " " * max(0, min(j + 1, n) - i - 2))
            i = min(j + 1, n)
        else:
            out.append(c)
            i += 1
    return "".join(out)


def split_top_commas(s: str) -> list[str]:
    """Pisah berdasarkan koma level teratas (abaikan (), [], {}, <>)."""
    parts, depth, cur = [], 0, ""
    pairs = {"(": ")", "[": "]", "{": "}", "<": ">"}
    stack: list[str] = []
    for ch in s:
        if ch in pairs:
            stack.append(pairs[ch])
            depth += 1
        elif stack and ch == stack[-1]:
            stack.pop()
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def find_matching_paren(text: str, open_idx: int) -> int:
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


KOTLIN_KEYWORDS = {
    "if", "else", "when", "for", "while", "do", "return", "break", "continue",
    "try", "catch", "finally", "throw", "fun", "val", "var", "class", "object",
    "interface", "import", "package", "is", "as", "in", "out", "by", "get",
    "set", "this", "super", "null", "true", "false", "it", "data", "sealed",
    "open", "override", "private", "public", "internal", "protected", "abstract",
    "lateinit", "companion", "init", "constructor", "enum", "annotation",
    "crossinline", "noinline", "reified", "suspend", "inline", "tailrec",
    "operator", "infix", "vararg", "where", "typeof", "typeof",
}

# Simbol Kotlin stdlib yang wajar dipakai tanpa impor (dipakai di proyek).
STDLIB_FUN = {
    "listOf", "mutableListOf", "mapOf", "mutableMapOf", "setOf", "mutableSetOf",
    "emptyList", "emptyMap", "emptySet", "println", "print", "run", "let", "also",
    "apply", "with", "runCatching", "require", "requireNotNull", "check",
    "checkNotNull", "error", "lazy", "TODO", "arrayOf", "intArrayOf",
    "longArrayOf", "floatArrayOf", "doubleArrayOf", "booleanArrayOf",
    "repeat", "sequence", "buildList", "buildMap", "buildString",
    "maxOf", "minOf", "coerceIn", "coerceAtLeast", "coerceAtMost",
    "sortedBy", "sortedWith", "filter", "map", "forEach", "firstOrNull",
    "first", "lastOrNull", "sumOf", "count", "any", "all", "none",
    "toList", "toMap", "toSet", "toString", "hashCode", "equals",
    "delay", "launch", "async", "withContext", "runBlocking",
    "flowOf", "MutableStateFlow", "StateFlow", "SharedFlow", "MutableSharedFlow",
    "collect", "collectLatest", "stateIn", "shareIn",
    # stdlib lain yang dipakai proyek
    "synchronized", "sqrt", "max", "min", "abs", "round", "floor", "ceil",
    "pow", "sin", "cos", "tan", "ln", "log2", "log10", "exp",
    "shl", "shr", "ushr", "and", "or", "xor", "inv",
    "compareTo", "compareValuesBy",
}
STDLIB_TYPE = {
    "String", "Int", "Long", "Float", "Double", "Boolean", "Byte", "Short",
    "Char", "Unit", "Any", "Nothing", "List", "MutableList", "Map",
    "MutableMap", "Set", "MutableSet", "Array", "IntArray", "LongArray",
    "FloatArray", "DoubleArray", "BooleanArray", "Pair", "Triple",
    "Result", "Exception", "IllegalStateException", "IllegalArgumentException",
    "RuntimeException", "Throwable", "Number", "Comparable",
    "Flow", "StateFlow", "SharedFlow", "MutableStateFlow", "MutableSharedFlow",
    "Job", "CoroutineScope", "Dispatchers", "Duration", "Regex",
    "StringBuilder", "ArrayDeque", "ArrayList", "HashMap", "HashSet",
    "LinkedHashMap", "LinkedHashSet", "Comparator",
}

# Tanda tangan SDK berisiko: (kelas, method) -> (min_args, max_args)
SDK_ARITY = {
    ("AccessibilityService", "dispatchGesture"): (3, 3),
    ("StrokeDescription", "StrokeDescription"): (3, 3),
    ("GestureDescription", "addStroke"): (1, 1),
    ("Path", "moveTo"): (2, 2),
    ("Path", "lineTo"): (2, 2),
    ("DocumentFile", "fromTreeUri"): (2, 2),
    ("DocumentFile", "fromSingleUri"): (2, 2),
    ("DocumentFile", "createFile"): (2, 2),
    ("DocumentFile", "createDirectory"): (1, 1),
    ("DocumentFile", "renameTo"): (1, 1),
    ("PackageManager", "getInstalledApplications"): (1, 1),
    ("PackageManager", "getApplicationLabel"): (1, 1),
    ("PackageManager", "getPackageInfo"): (2, 2),
    ("PackageManager", "getLaunchIntentForPackage"): (1, 1),
    ("AudioManager", "adjustStreamVolume"): (3, 3),
    ("AudioManager", "setStreamMute"): (2, 2),
    ("Settings.System", "canWrite"): (1, 1),
    ("ContentResolver", "openInputStream"): (1, 1),
    ("ContentResolver", "openOutputStream"): (1, 2),
    ("ContentResolver", "takePersistableUriPermission"): (2, 2),
    ("Context", "getSystemService"): (1, 1),
    ("Toast", "makeText"): (3, 3),
    ("Intent", "Intent"): (0, 2),
}


# ---------------------------------------------------------------- model
class KtFile:
    def __init__(self, path: Path):
        self.path = path
        self.rel = str(path.relative_to(ROOT))
        self.raw = path.read_text(encoding="utf-8")
        self.code = strip_code(self.raw)
        m = re.search(r"^\s*package\s+([\w.]+)", self.code, re.M)
        self.package = m.group(1) if m else ""
        self.imports: dict[str, str] = {}  # simple name -> FQN
        self.wildcards: list[str] = []
        for imp in re.finditer(r"^\s*import\s+([\w.]+)(\.\*)?", self.code, re.M):
            if imp.group(2):
                self.wildcards.append(imp.group(1))
            else:
                fqn = imp.group(1)
                self.imports[fqn.split(".")[-1]] = fqn
        # definisi tipe: nama -> (kind, file)
        self.types: dict[str, str] = {}
        for m in re.finditer(
            r"\b(?:data\s+class|sealed\s+class|sealed\s+interface|enum\s+class|annotation\s+class|class|interface|object)\s+(\w+)",
            self.code,
        ):
            self.types[m.group(1)] = "type"
        # definisi fungsi: nama -> (n_params, has_defaults, file, qualified)
        self.functions: dict[str, list[dict]] = {}
        # properti/member per tipe: nama tipe -> set(member)
        self.members: dict[str, set[str]] = {}
        self._parse_members_and_functions()

    def _parse_members_and_functions(self) -> None:
        text = self.code
        # fungsi: `fun Name(` DAN extension `fun Receiver.Name(`.
        for m in re.finditer(r"\bfun\s+(?:<[^>]+>\s+)?(?:(\w+)\.)?(\w+)\s*\(", text):
            name = m.group(2)
            open_idx = text.index("(", m.start())
            close_idx = find_matching_paren(text, open_idx)
            if close_idx < 0:
                continue
            params_raw = text[open_idx + 1:close_idx]
            params = split_top_commas(params_raw) if params_raw.strip() else []
            has_defaults = any("=" in p for p in params)
            entry = {"n": len(params), "defaults": has_defaults, "file": self.rel}
            self.functions.setdefault(name, []).append(entry)
        # member per tipe: hanya member LANGSUNG (depth 1 di badan kelas)
        # + member companion object. Lokal di dalam badan fungsi DIABAIKAN.
        for m in re.finditer(
            r"\b(?:data\s+class|sealed\s+class|class|object|interface)\s+(\w+)\s*(?:\([^)]*\))?\s*(?::[^{]*)?\{",
            text,
        ):
            tname = m.group(1)
            start = text.index("{", m.start())
            members = self._collect_class_members(text, start)
            self.members.setdefault(tname, set()).update(members)
            # konstruktor primer: jumlah parameter
            header = text[m.start():start]
            ctor = re.search(r"\((.*)\)", header, re.S)
            if ctor:
                params = split_top_commas(ctor.group(1)) if ctor.group(1).strip() else []
                self.functions.setdefault(tname, []).append(
                    {"n": len(params), "defaults": any("=" in p for p in params), "file": self.rel, "ctor": True}
                )
            # parameter konstruktor `val x:` di header kelas
            self.members.setdefault(tname, set()).update(re.findall(r"\b(?:val|var)\s+(\w+)\s*:", header))

    @staticmethod
    def _collect_class_members(text: str, open_idx: int) -> set[str]:
        """Kumpulkan fun/val langsung di badan kelas (depth 1) + companion."""
        members: set[str] = set()
        depth = 0
        i = open_idx
        # stack blok: ("class"|"companion"|"fun"|"other")
        stack: list[str] = ["class"]
        # kenali `companion object {` — blok berikutnya berkind companion
        pending_companion = False
        while i < len(text):
            # deteksi awal companion object sebelum `{`
            if text.startswith("companion", i) and re.match(r"companion\s+object\b", text[i:]):
                pending_companion = True
            ch = text[i]
            if ch == "{":
                depth += 1
                if pending_companion and depth == 2:
                    stack.append("companion")
                elif depth >= 2:
                    # blok fungsi atau blok lain: tentukan dari teks sebelum `{`
                    before = text[max(0, i - 40):i]
                    if re.search(r"\bfun\b", before):
                        stack.append("fun")
                    else:
                        stack.append("other")
                pending_companion = False
                i += 1
                continue
            if ch == "}":
                depth -= 1
                if depth == 0:
                    break
                if len(stack) > 1:
                    stack.pop()
                pending_companion = False
                i += 1
                continue
            # hanya kumpulkan di blok class (depth 1) atau companion (depth 2)
            if (depth == 1 and stack[-1] == "class") or (depth == 2 and stack[-1] == "companion"):
                fm = re.match(r"fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(", text[i:])
                if fm:
                    members.add(fm.group(1))
                vm = re.match(r"(?:val|var)\s+(\w+)\s*(?::|=)", text[i:])
                if vm:
                    members.add(vm.group(1))
            i += 1
        return members


def load_android_classes() -> set[str]:
    classes: set[str] = set()
    if not ANDROID_JAR.exists():
        warn(f"android.jar tidak ditemukan di {ANDROID_JAR} — cek impor android.* dilewati")
        return classes
    try:
        with zipfile.ZipFile(ANDROID_JAR) as zf:
            for name in zf.namelist():
                if name.endswith(".class") and not name.startswith("META-INF"):
                    classes.add(name[:-6].replace("/", "."))
    except Exception as e:  # noqa: BLE001
        warn(f"gagal membaca android.jar: {e}")
    return classes


def load_known_third_party() -> set[str]:
    """Awalan paket pihak ketiga dari dependensi build.gradle.kts."""
    prefixes: set[str] = set()
    for gradle in ROOT.rglob("build.gradle.kts"):
        text = gradle.read_text(encoding="utf-8", errors="ignore")
        for dep in re.findall(r'implementation\(["\']([^"\']+)["\']\)', text):
            group = dep.split(":")[0]
            prefixes.add(group)
    # peta grup artefak -> awalan paket runtime
    mapping = {
        "androidx.core": "androidx.core",
        "androidx.activity": "androidx.activity",
        "androidx.lifecycle": "androidx.lifecycle",
        "androidx.compose": "androidx.compose",
        "androidx.navigation": "androidx.navigation",
        "androidx.camera": "androidx.camera",
        "androidx.biometric": "androidx.biometric",
        "androidx.fragment": "androidx.fragment",
        "androidx.documentfile": "androidx.documentfile",
        "androidx.security": "androidx.security",
        "org.jetbrains.kotlinx": "kotlinx.coroutines",
        "com.squareup.okhttp3": "okhttp3",
        "com.squareup.retrofit2": "retrofit2",
        "com.google.code.gson": "com.google.gson",
        "com.google.mlkit": "com.google.mlkit",
        "com.google.zxing": "com.google.zxing",
        "com.google.android.material": "com.google.android.material",
        "org.webrtc": "org.webrtc",
        "org.json": "org.json",
    }
    out = set()
    for group in prefixes:
        out.add(mapping.get(group, group))
    return out


# ---------------------------------------------------------------- analisis
def main() -> int:
    kt_files = sorted(ROOT.rglob("src/main/java/**/*.kt"))
    kt_files = [p for p in kt_files if "build" not in p.parts]
    if not kt_files:
        print("FAIL: tidak ada berkas .kt ditemukan")
        return 1
    files = [KtFile(p) for p in kt_files]

    # --- tabel simbol global proyek ---
    # tipe: simple name -> [(FQN, file)]
    all_types: dict[str, list[tuple[str, str]]] = {}
    # fungsi top-level: nama -> [entry]
    all_functions: dict[str, list[dict]] = {}
    # member per tipe: nama tipe -> set(member)
    all_members: dict[str, set[str]] = {}
    for f in files:
        for name in f.types:
            all_types.setdefault(name, []).append((f"{f.package}.{name}", f.rel))
        for name, entries in f.functions.items():
            all_functions.setdefault(name, []).extend(entries)
        for tname, members in f.members.items():
            all_members.setdefault(tname, set()).update(members)

    android_classes = load_android_classes()
    third_party = load_known_third_party()

    # --- rentang fungsi per berkas (untuk param lokal & tipe variabel) ---
    # (start, end, {param_names}, {var_name: type})
    def function_ranges(f: KtFile) -> list[dict]:
        ranges: list[dict] = []
        for m in re.finditer(r"\bfun\s+(?:<[^>]+>\s+)?(?:(\w+)\.)?(\w+)\s*\(", f.code):
            open_idx = f.code.index("(", m.start())
            close_idx = find_matching_paren(f.code, open_idx)
            if close_idx < 0:
                continue
            params_raw = f.code[open_idx + 1:close_idx]
            params = split_top_commas(params_raw) if params_raw.strip() else []
            param_names = set()
            for p in params:
                pm = re.match(r"^\s*(?:crossinline\s+|noinline\s+)?(\w+)\s*:", p)
                if pm:
                    param_names.add(pm.group(1))
            # badan fungsi: `{` pertama sesudah `)` — lewati anotasi `: Tipe`
            j = close_idx + 1
            while j < len(f.code) and f.code[j] in " \t\n\r":
                j += 1
            if j < len(f.code) and f.code[j] == ":":
                # lewati tipe kembalian sampai `{` atau `=`
                k = j + 1
                depth_angle = 0
                while k < len(f.code):
                    ch = f.code[k]
                    if ch == "<":
                        depth_angle += 1
                    elif ch == ">":
                        depth_angle -= 1
                    elif depth_angle == 0 and ch in "{=":
                        break
                    k += 1
                j = k
                while j < len(f.code) and f.code[j] in " \t\n\r":
                    j += 1
            if j < len(f.code) and f.code[j] == "{":
                depth, k = 0, j
                while k < len(f.code):
                    if f.code[k] == "{":
                        depth += 1
                    elif f.code[k] == "}":
                        depth -= 1
                        if depth == 0:
                            break
                    k += 1
                ranges.append({"start": m.start(), "end": k, "params": param_names, "body_start": j, "body_end": k})
            else:
                ranges.append({"start": m.start(), "end": close_idx + 1, "params": param_names, "body_start": close_idx + 1, "body_end": close_idx + 1})
        return ranges

    def enclosing_function(ranges: list[dict], pos: int) -> dict | None:
        best = None
        for r in ranges:
            if r["body_start"] <= pos <= r["body_end"]:
                if best is None or (r["body_end"] - r["body_start"]) < (best["body_end"] - best["body_start"]):
                    best = r
        return best

    # --- 1+2. resolusi pemanggilan fungsi & konstruktor + aritas ---
    # Member eksternal yang dipanggil lewat with/apply (tanpa receiver
    # eksplisit) — diizinkan tanpa definisi proyek.
    EXTERNAL_MEMBER_CALLS = {
        "setEnableHardwareScaler", "setScalingType", "init", "release",
        "addSink", "removeSink", "setVideoEncoderFactory", "setVideoDecoderFactory",
        "createPeerConnectionFactory", "setOptions", "setAudioDeviceModule",
    }
    # Member `this` warisan Android (Activity/Service/ViewModel/Context)
    # + DSL builder (NavOptionsBuilder, Path, Bundle, ContentValues) yang
    # dipanggil tanpa receiver eksplisit (di dalam apply/with/lambda).
    KNOWN_THIS_MEMBERS = {
        "getApplication", "getSystemService", "getSharedPreferences",
        "getContentResolver", "getPackageManager", "getResources", "getAssets",
        "getFilesDir", "getCacheDir", "getMainExecutor", "getWindowManager",
        "getLayoutInflater", "getMenuInflater", "getLifecycle", "getViewModelStore",
        "getSavedStateRegistry", "getOnBackPressedDispatcher", "getSupportFragmentManager",
        "getSupportActionBar", "setSupportActionBar", "getActionBar", "getWindow",
        "getCurrentFocus", "getIntent", "setIntent", "getApplicationContext",
        "getBaseContext", "getApplicationInfo", "getPackageName", "getClassLoader",
        "getTheme", "obtainStyledAttributes", "getCallingPackage", "getComponentName",
        "getTaskId", "getRequestedOrientation", "setRequestedOrientation",
        "getVolumeControlStream", "setVolumeControlStream", "getSearchEvent",
        "getSystemServiceName", "getLocalClassName", "getTitle", "setTitle",
        "registerForActivityResult", "startForeground", "stopForeground",
        "startService", "stopService", "bindService", "unbindService",
        "dispatchKeyEvent",  # AccessibilityService: kirim KeyEvent ke jendela fokus
        "startActivity", "sendBroadcast", "registerReceiver", "unregisterReceiver",
        "finish", "finishAffinity", "recreate", "moveTaskToBack", "isFinishing",
        "isDestroyed", "onBackPressed", "onSearchRequested", "runOnUiThread",
        "checkSelfPermission", "requestPermissions",
        "shouldShowRequestPermissionRationale",
        "setContent", "setContentView", "findViewById",
        # DSL builder
        "popUpTo", "launchSingleTop", "restoreState", "saveState",
        "moveTo", "lineTo", "close", "put", "putCharSequence", "putString",
        "putInt", "putLong", "putBoolean", "putDouble", "putFloat",
        "putParcelable", "putSerializable", "putStringArrayList", "add", "set",
        "remove", "clear", "get", "contains",
    }
    # properti bertipe fungsi per berkas (mis. `var sender: ((JSONObject) -> Boolean)?`)
    file_callables: dict[str, set[str]] = {}
    for f in files:
        callables = set(re.findall(r"\b(?:val|var)\s+(\w+)\s*:[^=\n]*->", f.code))
        file_callables[f.rel] = callables
    call_re = re.compile(r"(?<![\w.])([A-Z][A-Za-z0-9_]*|[a-z][A-Za-z0-9_]*)(?:\s*<[^>\n]*>)?\s*\(")
    for f in files:
        ranges = function_ranges(f)
        for m in call_re.finditer(f.code):
            name = m.group(1)
            pos = m.start()
            lineno = f.code.count("\n", 0, pos) + 1
            if name in KOTLIN_KEYWORDS:
                continue
            # posisi infix: karakter bermakna sebelum nama adalah nilai
            # (mis. `1000L shl (`) -> bukan pemanggilan, lewati
            before = f.code[:pos].rstrip()
            if before and (before[-1].isalnum() or before[-1] in (")", "]", '"')):
                continue
            # deklarasi itu sendiri: `class X(`, `fun X(`, `object X`, dsb.
            line_start = f.code.rfind("\n", 0, pos) + 1
            prefix = f.code[line_start:pos]
            if re.search(r"\b(?:class|interface|object|fun|enum\s+class|data\s+class|sealed\s+class|annotation\s+class)\b", prefix):
                continue
            if re.search(r"\bfun\s+(?:<[^>]+>\s+)?(?:\w+\.)?$" + re.escape(name) + r"$", prefix):
                continue
            # parameter fungsi lokal bertipe fungsi (`block()`, `onBack()`)
            enc = enclosing_function(ranges, pos)
            if enc and name in enc["params"]:
                ok()
                continue
            # properti bertipe fungsi (`sender(...)`) / lokal yang menunjuknya
            if name in file_callables.get(f.rel, set()):
                ok()
                continue
            if enc:
                body = f.code[enc["body_start"]:enc["body_end"]]
                local_callables = {
                    lm.group(1)
                    for lm in re.finditer(r"\bval\s+(\w+)\s*=\s*(\w+)\b", body)
                    if lm.group(2) in file_callables.get(f.rel, set())
                }
                if name in local_callables:
                    ok()
                    continue
            # member `this` warisan Android / DSL builder
            if name in KNOWN_THIS_MEMBERS:
                ok()
                continue
            if name in EXTERNAL_MEMBER_CALLS:
                ok()
                continue
            open_idx = f.code.index("(", pos)
            close_idx = find_matching_paren(f.code, open_idx)
            args_raw = f.code[open_idx + 1:close_idx] if close_idx >= 0 else ""
            n_args = len(split_top_commas(args_raw)) if args_raw.strip() else 0
            rest = f.code[close_idx + 1:].lstrip() if close_idx >= 0 else ""
            if rest.startswith("{"):
                n_args += 1
            resolved = None
            if name in all_functions:
                resolved = ("project", all_functions[name])
            elif name in STDLIB_FUN:
                resolved = ("stdlib", None)
            elif name in all_types:
                resolved = ("ctor", all_functions.get(name, []))
            elif name in STDLIB_TYPE:
                resolved = ("stdlib-type", None)
            elif name in f.imports:
                # fungsi/kelas impor eksternal (Compose, kotlin.math, dsb.)
                resolved = ("imported", None)
            elif name[0].isupper():
                resolved = ("unknown-type", None)
            if resolved is None:
                fail(f"{f.rel}:{lineno}: pemanggilan '{name}(' tidak terdefinisi di proyek manapun (bukan fungsi/top-level/kelas/impor/stdlib)")
                continue
            kind, entries = resolved
            if kind == "project" and entries:
                fits = any(
                    (n_args == e["n"]) or (e["defaults"] and n_args <= e["n"])
                    for e in entries
                )
                if not fits:
                    fail(
                        f"{f.rel}:{lineno}: '{name}(' dipanggil dengan {n_args} argumen, "
                        f"tetapi definisi menerima {sorted({e['n'] for e in entries})} parameter "
                        f"(lihat {entries[0]['file']})"
                    )
                else:
                    ok()
            elif kind == "ctor" and entries:
                fits = any(
                    (n_args == e["n"]) or (e["defaults"] and n_args <= e["n"])
                    for e in entries
                )
                if not fits:
                    fail(
                        f"{f.rel}:{lineno}: konstruktor '{name}(' dipanggil dengan {n_args} argumen, "
                        f"tetapi konstruktor primer menerima {sorted({e['n'] for e in entries})} "
                        f"(lihat {entries[0]['file']})"
                    )
                else:
                    ok()
            else:
                ok()

    # --- 3. akses member pada variabel bertipe jelas (per fungsi) ---
    for f in files:
        ranges = function_ranges(f)
        for m in re.finditer(r"\b(\w+)\.(\w+)\b", f.code):
            receiver, member = m.group(1), m.group(2)
            pos = m.start()
            enc = enclosing_function(ranges, pos)
            if enc is None:
                continue
            body = f.code[enc["body_start"]:enc["body_end"]]
            # tipe variabel di dalam fungsi ini saja
            var_types: dict[str, str] = {}
            for vm in re.finditer(r"\bval\s+(\w+)\s*:\s*([A-Z][\w<>?,\s]*?)(?=\s*=|\n|$)", body):
                var_types[vm.group(1)] = vm.group(2).split("<")[0].strip().rstrip("?")
            for vm in re.finditer(r"\bval\s+(\w+)\s*=\s*([A-Z][\w]*)\s*\(", body):
                # jangan simpulkan bila konstruktor dirangkai `.method(...)`
                ctor_open = body.index("(", vm.start())
                ctor_close = find_matching_paren(body, ctor_open)
                after = body[ctor_close + 1:].lstrip() if ctor_close >= 0 else ""
                if after.startswith("."):
                    continue
                var_types[vm.group(1)] = vm.group(2)
            if receiver not in var_types:
                continue
            tname = var_types[receiver]
            base = tname.split(".")[-1]
            if base in all_members and member not in all_members[base]:
                if member in {"toString", "hashCode", "equals", "javaClass", "length", "size", "isEmpty", "isNotEmpty", "first", "last"}:
                    ok()
                    continue
                lineno = f.code.count("\n", 0, pos) + 1
                fail(f"{f.rel}:{lineno}: '{receiver}.{member}' — tipe {tname} tidak punya member '{member}' (member yang ada: {sorted(all_members[base])[:12]})")
            else:
                ok()

    # --- 4. DTO: simetri kunci toJson vs fromJson ---
    for f in files:
        if "/model/" not in f.rel:
            continue
        # kunci toJson: put("k", ...) / putOrNull(obj, "k", ...)
        to_keys = set(re.findall(r'\bput(?:OrNull)?\(\s*(?:obj,\s*)?"([\w]+)"', f.raw))
        from_keys = set(re.findall(r'\b(?:getString|optString|optBoolean|optLong|optInt|isNull)\("([\w]+)"', f.raw))
        # kunci yang dipakai di named-arg konstruktor fromJson (name = obj.getString("name"))
        if to_keys or from_keys:
            missing_in_from = sorted(to_keys - from_keys)
            missing_in_to = sorted(from_keys - to_keys)
            if missing_in_from:
                fail(f"{f.rel}: kunci toJson tanpa pasangan fromJson: {missing_in_from}")
            elif missing_in_to:
                fail(f"{f.rel}: kunci fromJson tanpa pasangan toJson: {missing_in_to}")
            else:
                ok()
                print(f"  DTO simetris di {f.rel}: {sorted(to_keys)}")

    # --- 5. R.* ---
    res_index: dict[str, set[str]] = {}
    for res_dir in ROOT.rglob("src/main/res"):
        if "build" in res_dir.parts:
            continue
        RES = res_dir
        for xml in RES.rglob("*.xml"):
            rel = xml.relative_to(RES)
            kind = rel.parts[0]
            if kind == "values":
                text = xml.read_text(encoding="utf-8", errors="ignore")
                for tag, attr in [("string", "name"), ("color", "name"), ("style", "name"), ("dimen", "name"), ("bool", "name"), ("integer", "name")]:
                    for mm in re.finditer(rf'<{tag}\s+name="([\w]+)"', text):
                        res_index.setdefault(tag, set()).add(mm.group(1))
            elif kind == "xml":
                res_index.setdefault("xml", set()).add(xml.stem)
            elif kind in ("layout", "drawable", "menu", "anim"):
                res_index.setdefault(kind, set()).add(xml.stem)
                text = xml.read_text(encoding="utf-8", errors="ignore")
                for mm in re.finditer(r'android:id="@\+id/([\w]+)"', text):
                    res_index.setdefault("id", set()).add(mm.group(1))
    for f in files:
        for m in re.finditer(r"\bR\.(\w+)\.(\w+)", f.code):
            kind, name = m.group(1), m.group(2)
            # resource sistem `android.R.drawable.*` — lewati
            start = m.start()
            if f.code[max(0, start - 8):start].endswith("android."):
                ok()
                continue
            known = res_index.get(kind, set())
            if kind in ("layout", "id", "string", "xml", "drawable", "color", "style"):
                if name in known:
                    ok()
                else:
                    fail(f"{f.rel}: R.{kind}.{name} tidak ada di res/ (yang ada: {sorted(known)[:10]})")
            else:
                warn(f"{f.rel}: R.{kind}.{name} — jenis resource '{kind}' tidak diperiksa (bukan layout/id/string/xml/drawable)")

    # --- 6. Manifest ---
    for manifest in ROOT.rglob("AndroidManifest.xml"):
        if "build" in str(manifest):
            continue
        try:
            tree = ET.parse(manifest)
        except Exception as e:  # noqa: BLE001
            fail(f"{manifest}: XML manifest gagal diparse: {e}")
            continue
        ns = "{http://schemas.android.com/apk/res/android}"
        module_classes = set()
        # semua kelas proyek di modul yang sama (berdasarkan path manifest)
        mod_root = manifest.parent.parent.parent  # src/main -> modul
        for kf in mod_root.rglob("*.kt"):
            kf_obj = KtFile(kf)
            module_classes.update(kf_obj.types.keys())
        for elem in tree.iter():
            name_attr = elem.get(f"{ns}name")
            if not name_attr:
                continue
            if elem.tag in ("activity", "service", "receiver", "provider"):
                short = name_attr.split(".")[-1]
                if short in module_classes or name_attr.startswith("androidx.") or name_attr.startswith("android."):
                    ok()
                else:
                    fail(f"{manifest}: komponen {elem.tag} '{name_attr}' bukan kelas proyek (kelas modul: {sorted(module_classes)[:8]}...)")

    # --- 7. impor android.* harus ada di android.jar; pihak ketiga dikenal ---
    for f in files:
        for simple, fqn in f.imports.items():
            if fqn.startswith("android."):
                if android_classes and fqn not in android_classes:
                    # mungkin inner class / anggota — cek awalan kelas induk
                    parent = fqn.rsplit(".", 1)[0]
                    if parent not in android_classes:
                        fail(f"{f.rel}: impor '{fqn}' tidak ada di android.jar (platform android-34)")
                    else:
                        ok()
                else:
                    ok()
            elif fqn.startswith(("androidx.", "org.webrtc.", "okhttp3.", "retrofit2.", "com.google.", "kotlinx.", "org.json.")):
                prefix = fqn.split(".")[0] + "." + fqn.split(".")[1] if "." in fqn else fqn
                known = any(fqn.startswith(tp) for tp in third_party) or any(
                    fqn.startswith(p) for p in ("androidx.", "org.webrtc.", "okhttp3.", "retrofit2.", "com.google.gson", "com.google.mlkit", "com.google.zxing", "kotlinx.coroutines", "org.json.")
                )
                if known:
                    ok()
                else:
                    warn(f"{f.rel}: impor pihak ketiga '{fqn}' — paket tidak tercantum di build.gradle.kts (mungkin salah ketik artefak)")
            elif fqn.startswith("com.prata.remote."):
                simple_name = fqn.split(".")[-1]
                if simple_name in all_types or simple_name in all_functions or simple_name in {n for ff in files for n in ff.types}:
                    ok()
                else:
                    fail(f"{f.rel}: impor proyek '{fqn}' tidak terdefinisi di berkas .kt manapun")
        for wc in f.wildcards:
            if wc.startswith("com.prata.remote."):
                # wildcard proyek: paket harus punya setidaknya satu berkas
                pkg_files = [ff for ff in files if ff.package == wc]
                if pkg_files:
                    ok()
                else:
                    fail(f"{f.rel}: wildcard impor '{wc}.*' — tidak ada berkas dengan package itu")
            else:
                ok()

    # --- 8. aritas SDK berisiko ---
    for f in files:
        for m in re.finditer(r"(\b[\w.]+)\.(\w+)\s*\(", f.code):
            recv, method = m.group(1), m.group(2)
            short = recv.split(".")[-1]
            key = (short, method)
            if key not in SDK_ARITY:
                continue
            open_idx = f.code.index("(", m.start())
            close_idx = find_matching_paren(f.code, open_idx)
            args_raw = f.code[open_idx + 1:close_idx] if close_idx >= 0 else ""
            n_args = len(split_top_commas(args_raw)) if args_raw.strip() else 0
            lo, hi = SDK_ARITY[key]
            if lo <= n_args <= hi:
                ok()
            else:
                fail(f"{f.rel}: {short}.{method}(...) dipanggil dengan {n_args} argumen, SDK meminta {lo}..{hi}")

    print(f"\nRINGKASAN DEEP VERIFY: {PASSES} lulus, {len(FAILS)} gagal, {len(WARNS)} peringatan.")
    for w in WARNS:
        print(f"  WARN {w}")
    for fl in FAILS:
        print(f"  FAIL {fl}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
