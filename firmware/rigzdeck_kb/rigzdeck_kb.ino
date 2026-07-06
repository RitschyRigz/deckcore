/*
 * RIGZDECK-KB — Hardware-Tastatur-Bridge (Arduino Micro / ATmega32U4)
 * ------------------------------------------------------------------
 * Meldet sich als ECHTES USB-HID-Boot-Keyboard an (indistinguishable von
 * einer physischen Tastatur — auch fuer Apps, die OS-injizierte Eingaben
 * verwerfen: TikTok Live Studio, Anti-Cheat, BIOS).  Gleichzeitig laeuft
 * ueber denselben USB (CDC) ein serieller Kommando-Port.
 *
 * Der Micro ist bewusst DUMM: er kennt keine Buttons, keine Makros. Er
 * bekommt Tasten-TOKEN ueber Serial und tippt sie. Die gesamte Logik
 * (welcher Button welche Tasten) lebt im Host (deckcore).
 *
 * Protokoll (zeilenbasiert, \n-terminiert, Gross/Klein egal):
 *   ID                       -> antwortet "RIGZDECK-KB v1"     (Discovery)
 *   K <tok> <tok> ...        -> Chord: alle Token zusammen druecken,
 *                               ~HOLD ms halten, in Gegenreihenfolge los.
 *                               antwortet "OK" oder "ERR:<token>"
 *   Beispiele:  K num1   |   K ctrl shift 1   |   K numadd
 *
 * Ein Makro (Tasten in Reihenfolge) = der Host schickt mehrere K-Zeilen
 * mit eigenem Timing dazwischen. Firmware bleibt damit minimal.
 *
 * Vokabular = identisch zu deckcores _VK_SPECIAL-Token (num0..num9,
 * numadd, num*, num-, num., num/, numenter, Pfeile, F1..F24, a..z, 0..9,
 * Modifier ctrl/shift/alt/win + r-Varianten).
 */

#include <HID-Project.h>

const unsigned int HOLD_MS = 20;   // Chord-Haltezeit

// Ein Token -> HID KeyboardKeycode, oder -1 wenn unbekannt.
int codeFor(String t) {
  t.toLowerCase();

  // -- Modifier --
  if (t == "ctrl" || t == "control" || t == "lctrl") return KEY_LEFT_CTRL;
  if (t == "rctrl")                                   return KEY_RIGHT_CTRL;
  if (t == "shift" || t == "lshift")                  return KEY_LEFT_SHIFT;
  if (t == "rshift")                                  return KEY_RIGHT_SHIFT;
  if (t == "alt" || t == "menu" || t == "lalt")       return KEY_LEFT_ALT;
  if (t == "ralt" || t == "altgr")                    return KEY_RIGHT_ALT;
  if (t == "win" || t == "super" || t == "cmd" ||
      t == "meta" || t == "gui" || t == "lwin")       return KEY_LEFT_GUI;
  if (t == "rwin")                                    return KEY_RIGHT_GUI;

  // -- Steuer-/Navigationstasten --
  if (t == "enter" || t == "return")   return KEY_ENTER;
  if (t == "esc" || t == "escape")     return KEY_ESC;
  if (t == "space")                    return KEY_SPACE;
  if (t == "tab")                      return KEY_TAB;
  if (t == "backspace")                return KEY_BACKSPACE;
  if (t == "delete" || t == "del")     return KEY_DELETE;
  if (t == "insert" || t == "ins")     return KEY_INSERT;
  if (t == "home")                     return KEY_HOME;
  if (t == "end")                      return KEY_END;
  if (t == "pageup")                   return KEY_PAGE_UP;
  if (t == "pagedown")                 return KEY_PAGE_DOWN;
  if (t == "up")                       return KEY_UP_ARROW;
  if (t == "down")                     return KEY_DOWN_ARROW;
  if (t == "left")                     return KEY_LEFT_ARROW;
  if (t == "right")                    return KEY_RIGHT_ARROW;
  if (t == "capslock")                 return KEY_CAPS_LOCK;
  if (t == "apps" || t == "contextmenu") return KEY_APPLICATION;
  if (t == "printscreen")              return KEY_PRINT;

  // -- Satzzeichen (US-Layout, Namen wie deckcore) --
  if (t == "minus")        return KEY_MINUS;
  if (t == "plus" || t == "equal") return KEY_EQUAL;   // '+' = shift+= auf US
  if (t == "comma")        return KEY_COMMA;
  if (t == "period")       return KEY_PERIOD;
  if (t == "slash")        return KEY_SLASH;
  if (t == "backslash")    return KEY_BACKSLASH;
  if (t == "semicolon")    return KEY_SEMICOLON;
  if (t == "quote")        return KEY_QUOTE;
  if (t == "bracketleft")  return KEY_LEFT_BRACE;
  if (t == "bracketright") return KEY_RIGHT_BRACE;
  if (t == "tilde" || t == "backquote") return KEY_TILDE;

  // -- Ziffernblock (ECHTE Keypad-Usages) --
  if (t == "numlock")                       return KEY_NUM_LOCK;
  if (t == "numadd" || t == "numplus")      return KEYPAD_ADD;
  if (t == "num-" || t == "numsub" || t == "numminus") return KEYPAD_SUBTRACT;
  if (t == "num*" || t == "nummul")         return KEYPAD_MULTIPLY;
  if (t == "num/" || t == "numdiv")         return KEYPAD_DIVIDE;
  if (t == "num." || t == "numdot")         return KEYPAD_DOT;
  if (t == "numenter")                      return KEYPAD_ENTER;
  if (t.length() == 4 && t.startsWith("num")) {
    char d = t.charAt(3);
    if (d >= '0' && d <= '9') return (d == '0') ? KEYPAD_0 : (KEYPAD_1 + (d - '1'));
  }

  // -- F-Tasten F1..F24 --
  if (t.charAt(0) == 'f' && t.length() >= 2) {
    int n = t.substring(1).toInt();
    if (n >= 1 && n <= 12)  return KEY_F1 + (n - 1);
    if (n >= 13 && n <= 24) return KEY_F13 + (n - 13);
  }

  // -- Einzelzeichen a..z / 0..9 --
  if (t.length() == 1) {
    char c = t.charAt(0);
    if (c >= 'a' && c <= 'z') return KEY_A + (c - 'a');
    if (c >= '1' && c <= '9') return KEY_1 + (c - '1');
    if (c == '0')             return KEY_0;
  }

  return -1;
}

// "K a b c" -> Chord druecken/halten/loslassen. Gibt "" zurueck bei Erfolg
// oder das erste unbekannte Token.
String pressChord(const String &args) {
  int codes[8];
  int n = 0;
  int i = 0;
  while (i < args.length() && n < 8) {
    while (i < args.length() && args.charAt(i) == ' ') i++;        // Leerzeichen ueberspringen
    int j = i;
    while (j < args.length() && args.charAt(j) != ' ') j++;
    if (j > i) {
      String tok = args.substring(i, j);
      int code = codeFor(tok);
      if (code < 0) return tok;                                    // unbekannt -> Fehler-Token
      codes[n++] = code;
    }
    i = j;
  }
  if (n == 0) return String("(leer)");

  for (int k = 0; k < n; k++) BootKeyboard.press((KeyboardKeycode)codes[k]);
  delay(HOLD_MS);
  for (int k = n - 1; k >= 0; k--) BootKeyboard.release((KeyboardKeycode)codes[k]);
  return String("");
}

void setup() {
  Serial.begin(115200);
  BootKeyboard.begin();
}

void loop() {
  static String line = "";
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      if (line.length() > 0) {
        if (line.equalsIgnoreCase("ID")) {
          Serial.println("RIGZDECK-KB v1");
        } else if (line.length() >= 2 && (line.charAt(0) == 'K' || line.charAt(0) == 'k')
                                       && line.charAt(1) == ' ') {
          String bad = pressChord(line.substring(2));
          if (bad.length() == 0) Serial.println("OK");
          else { Serial.print("ERR:"); Serial.println(bad); }
        } else {
          Serial.println("ERR:cmd");
        }
      }
      line = "";
    } else if (line.length() < 120) {
      line += c;
    }
  }
}
