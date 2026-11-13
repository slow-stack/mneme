// 仓库身份的可移植键（#581）：choro_repos.root_path 是本机绝对路径，双系统 /
// 双机共享同一个 memory.db 时它把 per-host 状态写进了 shared 状态——Windows 端
// 登记的行，macOS 端拼出来的路径不存在，再跑一次 T0 又多出第二行（从此不带
// repo 参数的调用命中 repo-ambiguous）。身份与位置从此分家：身份 = portable_key
// （remote URL 归一化；无 remote 时退化为根提交哈希），位置 = choro_repo_paths
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
 * - **URL 与 scp 分开解析**（PR #679 评审）：带 `://` 的形态里 authority 的冒号
 *   是**端口**（`ssh://host:2222/team/repo` 的 2222 不是路径段），只有 scp 形态
 *   （`git@host:path`，无协议头）的冒号才是路径分隔符。混着处理会把
 *   `ssh://host/2222/team/repo` 与 `ssh://host:2222/team/repo` 算成同一个身份。
 *   默认端口（ssh 22 / https 443 / git 9418）剥掉，其余端口保留——不同端口的
 *   两个服务本来就可能承载不同仓库；
 * - userinfo（含 token）**只在 authority 段内**剥掉：凭据不进键（泄进库里是
 *   一回事，令牌轮换后同一仓库算出不同键是另一回事），但仓库路径里的 `@`
 *   （`team/repo@stable`）不是 userinfo，不能拿全串的 lastIndexOf 去切。
 */
export function normalizeGitUrl(rawUrl) {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    let s = raw.slice(schemeMatch[0].length).replace(/\/+$/, "").replace(/\.git$/i, "");
    const slash = s.indexOf("/");
    let authority = slash === -1 ? s : s.slice(0, slash);
    const path = slash === -1 ? "" : s.slice(slash);
    const at = authority.lastIndexOf("@");
    if (at !== -1) authority = authority.slice(at + 1);
    const portMatch = /:(\d+)$/.exec(authority);
    if (portMatch) {
      const defaultPort = { ssh: "22", "git+ssh": "22", https: "443", http: "80", git: "9418" }[scheme];
      if (portMatch[1] === defaultPort) authority = authority.slice(0, portMatch.index);
    }
    const out = (authority + path).toLowerCase();
    return out || null;
  }
  // scp 形态：`[user@]host:path`；没有协议头，冒号是路径分隔符。
  let s = raw.replace(/\/+$/, "").replace(/\.git$/i, "");
  const at = s.indexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  const colon = s.indexOf(":");
  if (colon === -1) return s.toLowerCase() || null;
  const host = s.slice(0, colon);
  const path = s.slice(colon + 1);
  const out = `${host}/${path}`.toLowerCase();
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
