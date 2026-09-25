// Word lists for GDScript (Godot 4) highlighting, shared by the diff-view
// highlight.js grammar (gdscriptHljs.ts) and the CodeMirror stream mode
// (gdscriptLanguage.ts) so both stay in sync. Update this file when a Godot
// release adds keywords or annotations — everything else is regexes.

// Control flow and operators spelled as words (`and`/`in`/`is`…).
export const GDSCRIPT_CONTROL_KEYWORDS = [
  "if", "elif", "else", "for", "while", "match", "when",
  "break", "continue", "pass", "return", "await",
  "and", "or", "not", "in", "is", "as",
];

// Declarations and other reserved words.
export const GDSCRIPT_KEYWORDS = [
  "class", "class_name", "extends",
  "signal", "func", "static", "const", "enum", "var",
  "self", "super", "assert", "breakpoint", "void", "abstract",
  // Reserved for future use per the GDScript reference; not valid identifiers.
  "trait", "yield",
];

// `true` / `false` / `null`.
export const GDSCRIPT_LITERALS = ["true", "false", "null"];

// Global constants from @GDScope.
export const GDSCRIPT_CONSTANTS = ["PI", "TAU", "INF", "NAN"];

// Variant types usable in type hints (`var hp: int`). Engine and user classes
// (Node2D, Player, …) are covered by the any-capitalized-identifier rules in
// the grammars instead of a list, since custom classes are unbounded.
export const GDSCRIPT_TYPES = [
  "bool", "int", "float",
  "String", "StringName", "NodePath",
  "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i",
  "Rect2", "Rect2i", "Transform2D", "Transform3D", "Projection",
  "Plane", "Quaternion", "AABB", "Basis", "Color", "RID", "Object",
  "Callable", "Signal", "Dictionary", "Array",
  "PackedByteArray", "PackedInt32Array", "PackedInt64Array",
  "PackedFloat32Array", "PackedFloat64Array", "PackedStringArray",
  "PackedVector2Array", "PackedVector3Array", "PackedVector4Array",
  "PackedColorArray",
];

// Curated @GDScope built-in functions (the ones a human actually calls; the
// full list is ~200 names and mostly trig nobody reads in a diff).
export const GDSCRIPT_BUILTINS = [
  "print", "print_rich", "print_debug", "printerr", "printraw", "prints", "printt",
  "push_error", "push_warning",
  "str", "range", "len", "typeof", "type_string", "hash", "weakref",
  "abs", "absf", "absi", "sign", "signf", "signi",
  "clamp", "clampf", "clampi", "lerp", "lerpf", "lerp_angle", "inverse_lerp",
  "remap", "smoothstep", "move_toward", "pingpong", "wrapf", "wrapi",
  "min", "minf", "mini", "max", "maxf", "maxi",
  "round", "roundf", "roundi", "floor", "floorf", "floori",
  "ceil", "ceilf", "ceili", "snapped", "snappedf", "snappedi",
  "sqrt", "pow", "exp", "log",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "ease", "step_decimals",
  "deg_to_rad", "rad_to_deg", "linear_to_db", "db_to_linear",
  "randf", "randi", "randfn", "randomize", "rand_from_seed", "seed",
  "is_equal_approx", "is_zero_approx", "is_nan", "is_inf", "nearest_po2",
  "instance_from_id", "is_instance_id_valid", "is_instance_valid",
  "error_string", "preload", "load",
];

// Prefixes for the mode state: the word right after one of these is a name
// being defined, not a plain identifier.
export const GDSCRIPT_NAME_INTRODUCERS = ["func", "signal", "class", "class_name", "extends", "enum"];
