import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Các font mà studio cho phép chọn. Trình duyệt nạp chúng qua `@font-face` trong `public/fonts.css`,
// còn librsvg (bên trong sharp) nạp đúng những file này qua fontconfig — cùng một bộ file cho cả hai
// phía là điều kiện để chữ trong ảnh tải về khớp với preview.
export const FONT_DIRECTORY = fileURLToPath(new URL("../public/fonts/", import.meta.url));

// `Courier New` không có bản tự do; Courier Prime là bản thay thế cùng hình dáng và cùng bề rộng.
const FONT_ALIASES = [["Courier New", "Courier Prime"]];

// Bebas Neue, Poppins và Courier Prime không có glyph tiếng Việt dựng sẵn (ệ, ấ, ề, ư, ở, ỹ...).
// Nếu để trình duyệt và server tự chọn font thay thế thì mỗi bên rơi vào một font khác nhau.
// Khai báo sẵn một chuỗi dự phòng dùng chung để cả hai bên lấy glyph từ cùng một file.
export const FALLBACK_FAMILY = "TikTok Sans";

/** Chuỗi font cho thuộc tính `font-family`, dùng y hệt ở CSS của preview và ở SVG của bản render. */
export function fontStack(family) {
  const primary = String(family || FALLBACK_FAMILY);
  return primary === FALLBACK_FAMILY ? [primary, "sans-serif"] : [primary, FALLBACK_FAMILY, "sans-serif"];
}

export const FONT_FILES = Object.freeze({
  "TikTok Sans": ["TikTokSans-Variable.ttf"],
  "Montserrat": ["Montserrat-Variable.ttf"],
  "Playfair Display": ["PlayfairDisplay-Variable.ttf"],
  "Roboto": ["Roboto-Variable.ttf"],
  "Bebas Neue": ["BebasNeue-Regular.ttf"],
  "Courier Prime": ["CourierPrime-Regular.ttf", "CourierPrime-Bold.ttf"],
  "Poppins": [
    "Poppins-Regular.ttf", "Poppins-Medium.ttf", "Poppins-SemiBold.ttf",
    "Poppins-Bold.ttf", "Poppins-ExtraBold.ttf", "Poppins-Black.ttf"
  ]
});

const xmlEscape = value => String(value).replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);

function buildConfig(cacheDirectory) {
  const aliases = FONT_ALIASES.map(([from, to]) => `
  <match target="pattern">
    <test name="family"><string>${xmlEscape(from)}</string></test>
    <edit name="family" mode="assign" binding="strong"><string>${xmlEscape(to)}</string></edit>
  </match>`).join("");
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${xmlEscape(FONT_DIRECTORY)}</dir>
  <cachedir>${xmlEscape(cacheDirectory)}</cachedir>
  <!-- Giữ font hệ thống làm dự phòng cho ký tự nằm ngoài bộ font đi kèm (emoji, chữ CJK...). -->
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>${aliases}
</fontconfig>
`;
}

/**
 * Trỏ fontconfig vào bộ font đi kèm repo. Phải chạy trước lần render chữ đầu tiên vì fontconfig
 * chỉ đọc biến môi trường một lần rồi cache lại trong tiến trình.
 * Tôn trọng FONTCONFIG_FILE có sẵn để môi trường triển khai vẫn tự cấu hình được.
 */
export function configureFonts() {
  if (process.env.FONTCONFIG_FILE) return process.env.FONTCONFIG_FILE;
  if (!fs.existsSync(FONT_DIRECTORY)) return null;
  const cacheDirectory = path.join(os.tmpdir(), "lana-fontconfig-cache");
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const configPath = path.join(cacheDirectory, "fonts.conf");
  fs.writeFileSync(configPath, buildConfig(cacheDirectory));
  process.env.FONTCONFIG_FILE = configPath;
  return configPath;
}

/** Các font thiếu file — dùng cho health check và test. */
export function missingFontFiles() {
  return Object.entries(FONT_FILES).flatMap(([family, files]) =>
    files.filter(file => !fs.existsSync(path.join(FONT_DIRECTORY, file))).map(file => `${family}: ${file}`));
}

configureFonts();
