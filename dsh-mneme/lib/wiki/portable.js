// 仓库身份的可移植键（#581）：choro_repos.root_path 是本机绝对路径，双系统 /
// 双机共享同一个 memory.db 时它把 per-host 状态写进了 shared 状态——Windows 端
// 登记的行，macOS 端拼出来的路径不存在，再跑一次 T0 又多出第二行（从此不带
// repo 参数的调用命中 repo-ambiguous）。身份与位置从此分家：身份 = portable_key
// （remote URL 归一化；无 remote 时退化为仓库名），位置 = choro_repo_paths
// 每机一行（host_id = os.hostname()）。
import { execFileSync } from "node:child_process";
import os from "node:os";

/**
 * 当前宿主的稳定 id。跨端共享库时每台机器各占一行位置；同一台机器双系统
 * （Windows / macOS 各有 hostname）天然是两行，与「两份工作副本」一一对应。
 */
export function hostId() {
  return os.hostname();
}

/**
 * remote URL → 归一化身份串。目标形态：`host/path`（全小写）。
 * - 协议头（https:// / ssh:// / git://）剥掉；
 * - 尾部 `/` 与 `.git` 剥掉；
 * - scp 形态 `git@host:path` 的冒号换成 `/`——判据是冒号在最后一个 `@` 之后、
 *   第一个 `/` 之前；https 的 userinfo（`user:token@host`）冒号在 `@` 之前，
 *   **不能动**：token 换成 `/` 既毁匹配、还会把凭据的形状带进键里；
 * - userinfo（含 token）整体剥掉：凭据不进键——泄进库里是一回事，令牌轮换
 *   后同一仓库算出不同键是另一回事，两个都不可接受。
 */
export function normalizeGitUrl(rawUrl) {
  let s = String(rawUrl ?? "").trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/i, "");
  const firstSlash = s.indexOf("/");
  const authority = firstSlash === -1 ? s : s.slice(0, firstSlash);
  const at = authority.lastIndexOf("@");
  const colon = authority.indexOf(":", at + 1);
  if (colon !== -1) {
    s = authority.slice(0, colon) + "/" + authority.slice(colon + 1)
      + (firstSlash === -1 ? "" : s.slice(firstSlash));
  }
  const at2 = s.lastIndexOf("@");
  const hostStart = at2 === -1 ? 0 : at2 + 1;
  const out = s.slice(hostStart).toLowerCase();
  return out || null;
}

function gitRemoteUrl(repoRoot) {
  try {
    // stderr 接管：无 remote 时 git 写 stderr，不能让它漏到 CLI 界面上。
    const out = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

/** 根提交哈希：同一仓库历史的第一个提交，跨副本恒定（与 HEAD 无关）。 */
function gitRootCommit(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(out).trim().split("\n").filter(Boolean);
    // 多根（嫁接历史）取字典序最小：同一仓库在任何副本上必须算出同一个键。
    return lines.length ? lines.sort()[0] : null;
  } catch {
    return null;
  }
}

/**
 * 仓库的可移植身份。优先 remote.origin.url 归一化；无 remote 退化到根提交
 * 哈希（`git:<hash>`）——它跨副本恒定，又与「碰巧同名的别的仓库」天然区分。
 * issue #581 提的「退化为仓库名」不能用：目录名与 package.json name 的重合率
 * 极高（docs / scripts / 同一模板起家的一批仓库），拿它作键会把两个不相干的
 * 仓库收敛成一行，第二次登记就吃掉别人的页。两级都拿不到（非 git 目录）返回
 * null：那行退回 root_path 的旧语义，不硬造身份。
 */
export function portableKeyFor(rootPath) {
  const key = normalizeGitUrl(gitRemoteUrl(rootPath));
  if (key) return key;
  const rootCommit = gitRootCommit(rootPath);
  if (rootCommit) return `git:${rootCommit}`;
  return null;
}
