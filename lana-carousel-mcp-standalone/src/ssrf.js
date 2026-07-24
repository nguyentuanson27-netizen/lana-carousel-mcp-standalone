import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors.js";

const blockedSuffixes = [".local", ".localhost", ".internal", ".lan", ".home"];

export function parseRemoteUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("INVALID_IMAGE_URL", "URL ảnh không hợp lệ.");
  }

  if (url.protocol !== "https:") {
    throw new AppError("UNSUPPORTED_PROTOCOL", "Chỉ chấp nhận URL HTTPS.");
  }
  if (url.username || url.password) {
    throw new AppError("INVALID_IMAGE_URL", "URL không được chứa thông tin đăng nhập.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    blockedSuffixes.some((suffix) => host.endsWith(suffix)) ||
    (!host.includes(".") && isIP(host) === 0)
  ) {
    throw new AppError("BLOCKED_HOST", "Hostname nội bộ bị chặn.");
  }
  return url;
}

export function assertPublicIp(address) {
  let parsed;
  try {
    parsed = ipaddr.process(address);
  } catch {
    throw new AppError("SSRF_BLOCKED", "IP không hợp lệ.");
  }
  if (parsed.range() !== "unicast") {
    throw new AppError("SSRF_BLOCKED", "URL trỏ tới vùng IP không công khai.");
  }
}

export async function resolvePublicHost(hostname) {
  if (isIP(hostname)) {
    assertPublicIp(hostname);
    return [{ address: hostname, family: isIP(hostname) }];
  }

  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError("REMOTE_DNS_FAILED", "Không phân giải được tên miền nguồn ảnh.", 404);
  }
  if (!answers.length) {
    throw new AppError("REMOTE_DNS_FAILED", "Tên miền không có địa chỉ IP.", 404);
  }
  for (const answer of answers) assertPublicIp(answer.address);
  return answers;
}
