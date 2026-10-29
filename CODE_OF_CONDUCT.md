# Code of Conduct

> **English** | [中文](#行为守则)

This repository is a memory plugin for the DeepSeek Harness host: it distils sessions into memories,
injects them back, and lets a user own, search and forget their own record. What it is about is
**whose memory it is**.

This code is built on the labour theory of value and on resistance to alienation. It does not list
protected identities, and that is not a gap: Section 6 forbids harassment of **anyone**, which needs
no list to be complete, and Section 3 allocates voice by evidence rather than by identity, which is
what a list would otherwise be doing.

---

## 0. A boundary: this code does not change the licence

Nothing here narrows the rights granted by the MIT licence.

| | Bound by this code |
|---|---|
| People who **use** this plugin | No. MIT already grants it; we add no conditions |
| People who **participate** here (issues, pull requests, reviews, discussion) | Yes. These are the rules of our own house |

A conduct document cannot add terms to a permissive licence, and saying so is the first thing it
owes the reader.

---

## 1. Attribution goes to people. AI is a means of production, not an author.

An AI model has no subjective agency. It does not decide, does not answer for anything, and cannot
be held responsible when a regression ships. It is a **means of production and an instrument of
labour** — like a compiler, or a build server.

Attribution therefore goes to the person, and only to the person. That is not a compromise we make;
it is the only correct arrangement.

**A model is never recorded as an author.** Writing one there does not credit the tool; it removes the
person the record exists to point at. Section 2 sets out why that follows from what responsibility is,
rather than from a preference about tools.

Value comes from labour. An instrument of production does not create value, and cannot be its author.

### The distinction that matters

Two sentences look similar and are not:

| | Verdict |
|---|---|
| "This change was written with AI assistance; here is what I checked and why I believe it." | **Encouraged.** This is method disclosure, and it is honest |
| `Co-Authored-By: <model or agent>`, `Generated with …`, an agent listed as author | **Not accepted.** This is attribution, and it is false |

Disclosing your method tells the reader how to audit you. Naming a model as author tells the reader
the opposite of the truth. The first is owed to reviewers; the second is refused here.

**A trailer can appear without anyone typing it.** If a pull request carries commits from more than one
author, GitHub's squash merge writes a `Co-Authored-By` line for each of them. A contributor who
followed this rule perfectly can still end up with one, and the merge is not their act. If it happens,
say so in the pull request; nobody will treat it as a violation. Section 8 shows the two times it
happened here. This carve-out is written into the rule itself, not only into this document: see
[CONTRIBUTING.md](CONTRIBUTING.md) under *Commit attribution is mandatory*, and the corresponding line
in [AGENTS.md](AGENTS.md). Three documents, one answer.

That is not an invitation to squash other people's names away. Where the extra authors are you under
another address, or a machine identity, collapsing them costs nothing. Where they are **another person**,
their credit has to survive the squash — in the commit body, in words, the same way the next paragraph
describes. Removing a real co-author to keep the trailer rule clean would break Section 6 instead.

**One case needs saying out loud, because the rule would otherwise eat it.** When you rebase and take
over work someone else wrote — a pull request that was closed unmerged, a patch you had to rebuild —
the credit is theirs and must not be dropped. The trailer rule does not license dropping it: write the
provenance in the commit body or the pull request description, in words — "this carries work
originally authored by <name> in #<number>". That is disclosure, and it is checkable. What is refused
is the *trailer as the mechanism*, because a trailer is a claim the machine reads and the reader does
not. Section 8 describes the one case here where a trailer was used for exactly this, before the rule
existed.

The practical rule is already in [CONTRIBUTING.md](CONTRIBUTING.md): the author line is the only
attribution mechanism, and no `Co-Authored-By:` trailer is accepted — not for a person, not for a bot,
not for an AI tool. (`Signed-off-by` is a different thing and is not banned by this clause: it asserts
that you had the right to submit the change, it does not claim anyone wrote it.) The two halves of that
sentence were decided on different days, and the difference is not decoration: **no AI attribution**
was decided on **2026-09-19**, and the wider ban on *any* trailer was written down on **2026-10-18**.
Section 8 has the receipts, including the part of our own history this rule now judges.

**Those two dates are the honest part, and we are not going to tidy the gap between them.** This
repository's own history shows both sides of it: commits before 2026-09-19 carry co-author trailers —
a few of them naming a model — and so do commits from the month between the decision and the sentence
that made it checkable. None of them are being edited out. A history rewritten to satisfy a later rule
is worth less than one that records what actually happened, including the part we would do differently
now.

Read those commits as evidence of **when the practice changed** — not as an exception still on offer.
A rule that had not been written down yet is not a rule anyone could have followed, which is why the
cutoff below is the second date and not the first.

---

## 2. What matters is not who typed it, but who answers for it

Much of this codebase is written by agents running in parallel worktrees, on branches a maintainer
reviews and merges. This code does not pretend otherwise, and it does not treat that as a problem to
be hidden.

What it insists on is **where responsibility lands**.

The labour process has three moments: the person who works, the instruments they work with, and the
material worked on. The instrument is one moment of that process and never its subject — it has no
purpose of its own, no stake in the result, and nothing to lose when the result is wrong.
**Responsibility follows from having something at stake, and that is a position only a person can
occupy.**

- **Responsibility is a social relation, not a label.** It holds only where someone can be asked and
  must answer, can be corrected, can lose the standing to commit again. A model has no stake in the
  outcome and no standing to answer for it. It cannot be responsible — not because we withhold the
  title, but because there is nothing there for the title to attach to.
- **So responsibility cannot stop at the tool. It can only land on a person.** Putting a model on the
  author line does not add a second responsible party; it removes the only one that existed and
  leaves the history unable to answer for itself. The author line must name a person — not as a
  courtesy to humans, but because a record that points at an instrument points at nothing.
- **The same rule cuts both ways.** Because the responsibility is a person's, the tool is never a
  defence: "the model wrote it" is no more an answer to "why is this correct" than "the compiler
  accepted it" is. Whoever signs the line owns the whole diff, including the lines they did not type.
- **Method disclosure belongs in the open** — in the pull request description, in the commit body, in
  a review comment: what was generated, what was checked, what was rejected. A reviewer who knows how
  a patch was produced can audit it; one who does not is guessing. Disclosure is not a disclaimer: it
  tells the reader how to check you, not who to blame instead.
- **A human reads every line before it is submitted.** If you cannot explain a change, do not submit
  it — that applies to code copied from a blog post exactly as it applies to code produced by a
  model.

---

## 3. Voice is allocated by evidence, not by identity

- Whether a change stands is decided by the test suite, the reproduction, the code and the issue
  history — **not by the contributor's seniority, institution, degree, language or star count**.
- A **design may be called wrong. A person may not be called wrong for having proposed it.**
- If you find yourself explaining a bug by who wrote the code rather than by what the code does,
  stop.

This holds in both directions: it protects the people whose positions you disagree with.

---

## 4. Technology must serve human liberation

This section is a **statement of the maintainers' position**, not a restriction on downstream use
(see Section 0).

- This plugin exists because a person's memory of their own work should belong to them, not to a
  platform. Memories stay in a local database the user can read, export and delete. **We do not
  accept contributions whose purpose is to make that record harder for its owner to reach** —
  telemetry that ships memory contents off the machine, a "convenience" that makes deletion
  unreliable, an integration that quietly makes the user's data the vendor's asset.
- We welcome argument that lands on a mechanism: a fail-safe that does not fail safe, a scoring rule
  that silently buries what a user said, an injection budget that crowds out the thing that mattered.
- We **do not pretend to be neutral.** This project takes a position on who owns a memory. The way to
  disagree is with a reproduction and a design, not a slogan.

---

## 5. Solidarity: the real barriers, written down

"Background does not matter" is empty unless it is spelled out. These are the barriers we know
about, and what we do about them.

| Barrier | How it actually bites | What this repository does |
|---|---|---|
| **Language** | The code comments and nearly all of the documentation are in Chinese; only the top-level README exists in both languages. A contributor who reads only English pays for it twice | A review comment in either language is a valid review. Ask for a translation rather than guessing at intent — translating a document is a contribution, not a complaint |
| **Time** | Unpaid maintenance has no service level, and an issue that sits for a month is not an insult | No response-time expectation on anyone, maintainers included. A stalled pull request is not an abandoned one — ask before acting on it |
| **Credentials** | Institutions have letterheads; individuals do not | Affiliation, degree and employer are not evidence. **A reproduction from a student and a reproduction from a company are the same reproduction** |
| **Hardware** | Local inference runs on CPU (a 1 GB footprint), but GPU acceleration is optional and wants a CUDA backend most contributors will not have — so two people testing the same feature are not testing the same thing | A report that says which path was exercised, and what was unavailable, is a useful report. Missing hardware is not a missing contribution |

---

## 6. Unacceptable behaviour

- Removing or obscuring attribution; presenting another person's work as your own.
- Adding `Co-Authored-By:` or `Generated with …` to a commit, or listing a model or agent as author.
  (Three commits already in this repository do the last one. Section 8 says where they are and why they
  stay.)
- Submitting a change you cannot explain, and answering review questions by pointing at the tool.
- Personal attacks, insults, belittling or mocking contributors.
- Harassment, stalking, threats, doxxing, or publishing private information — **of anyone, whatever
  their identity, and including a user's memories, session content, or anything read out of a local
  database.** This clause has no list of who it covers, because a list would leave out the next person.
- Brigading, ragebait, coordinated inauthentic activity, or rank manipulation — including automated
  starring. GitHub's Acceptable Use Policies §4 treats that as abuse; so do we.

---

## 7. Enforcement: repair before removal

1. **Repair.** Where the harm is a wrong attribution, a false claim about a benchmark or a
   misrepresented position, the first remedy is to put it right: restore the name, correct the
   record, reinstate withdrawn text, and note the correction in public.
2. **Warning.** A written notice naming the clause and the specific act — which sentence, in which
   thread.
3. **Restriction.** A limit on one issue or one thread, for a stated period.
4. **Removal.** Last, not first. A permanent ban is for conduct that continues after warning, or for
   harm that cannot be repaired — doxxing, threats, fabricated sources at scale.

Rules on the people applying this:

- A decision to restrict or remove cites the clause and the evidence. **Unexplained removal is itself
  a violation of this code.**
- **The attribution rule has no retroactive force.** Nothing before **commit `b4a7f52`, 2026-10-18** —
  the commit that wrote it down and made it checkable — is enforcement material for Sections 1 and 6's
  attribution clause: not the AI co-author trailers in our own history, and not anything in anyone
  else's. A rule that can be applied backwards is a rule nobody can rely on.

  **This applies to the attribution rule only.** Harassment, doxxing and threats are not dated: a
  maintainer who hurt someone before 2026-10-18 does not get a grace period, and neither does anyone
  else. A cutoff that protected the powerful would be worse than no cutoff at all.
- Maintainers do not own contributors' labour. Merging a pull request does not transfer authorship,
  and closing one does not delete what it taught.
- A maintainer with a stake in the dispute says so and asks someone else to decide.
- Disagreement with a maintainer's decision goes to a public issue, not a private message.
- **A report of harassment is the exception to "in public".** Send it privately — `work@modusensus.space`,
  the same address [SECURITY.md](SECURITY.md) uses, or a
  [private advisory](https://github.com/slow-stack/mneme/security/advisories) — because the person
  reporting harm should not have to be exposed to argue about it in a thread. Everything else in this
  document defaults to public, and that is deliberate: public process is the only process a maintainer
  cannot quietly bend.

---

## 8. Our own record, written down

A code that binds from today and says nothing about yesterday invites one question, and it is a fair
one: what about what you already did? This section answers it with the numbers, before someone else
does it for us.

### The rule was decided before it was written down

- **2026-09-19.** `AGENTS.md` states the narrow version: commits must carry no AI attribution.
- **2026-10-18, commit `b4a7f52`.** The rule is widened to *any* `Co-Authored-By` trailer, whoever it
  points at. The same commit dates the widened rule back to 2026-09-19.
- **Before `b4a7f52`,** `CONTRIBUTING.md` contained no such rule at all.

And the narrow rule was not merely declared. Between 2026-09-19 and 2026-10-18 no commit on `main`
carried a model as co-author; the last one is `14cad35`, on 2026-09-13. The date `CONTRIBUTING.md`
claims is therefore not a fiction — it is the day the practice actually stopped, stated one month
before anyone wrote down the wider rule that made it machine-checkable.

So 2026-09-19 is the day the practice was decided against, and 2026-10-18 is the day it became
checkable. Both dates are real; they are not the same date. `CONTRIBUTING.md` and `AGENTS.md` still
say 2026-09-19, and this document does not quietly edit them: **the line used for enforcement here is
`b4a7f52` itself**, because a rule nobody had written down is a rule nobody could have checked, and an
unchecked rule cannot be held against anyone.

Note which way that cuts. The line is the *later* of the two dates, and it applies to **both** halves of
the rule — so a commit from the window that listed a model as *author* would also fall outside it, even
though the narrow rule had already been written down by then. That is the deliberate direction: being
generous about our own past costs less than a rule that bites whichever neck it reaches first.

### What is actually in the history

Counted on `main` by commit date, as of 2026-10-28 — 826 commits at that moment, and the numbers below
are a snapshot, not a live query. They are stated with a date so that a later reader who counts
differently knows to compare against that date rather than against today:

| Period | Commits | Carrying a `Co-Authored-By` trailer |
|---|---|---|
| Before 2026-09-19 | 172 | 69 |
| 2026-09-19 → `b4a7f52` (the window) | 492 | 15 |
| `b4a7f52` → end of 2026-10-18 | 20 | 2 |
| From 2026-10-19 | 142 | 0 |

One commit before the window (`b9a4ee2`, 2026-09-10) *mentions* the trailer syntax in its message while
carrying no trailer; it is not in the count. A grep for the string finds 70 where the table says 69,
and that gap is the whole of the difference.

Every one of the 15 in the window was read, one by one. **None of them takes credit for another
person's work.** They are this repository's own people naming themselves, plus one case of doing the
right thing in the wrong place: keeping a real author's credit, which Section 1 requires, through a
mechanism the widened rule forbids — which is why Section 1 tells you to write it in the commit body
instead.

They are not listed here. That is deliberate: naming them would turn a statement about a practice into
a list of people to go and look at, and the finding does not depend on which commits they are. Anyone
who wants to check it can run the same `git log` and read the same 15; anyone who wants to use the
list against someone will have to do that work themselves.

The two after `b4a7f52` were not typed by anyone. GitHub's squash merge collapses a multi-author pull
request into one author plus `Co-Authored-By` lines, and the release workflow commits under a fixed
identity. Both are machine output from the merge, not a claim.

### Where a model or a bot does appear in the author line

Section 6 forbids listing a model or an agent as an author. Three commits here do exactly that, all of
them before the line:

- `930b0f7` (2026-09-06, pull request #62): Copilot as author, from GitHub's coding agent.
- `f27c70f` (2026-09-17, #212) and `fafc97b` (2026-09-16, #204): `github-actions[bot]`, release
  preparation.

They stay where they are. Editing them out would make the record state something that did not happen,
which is the one thing this document exists to oppose. Section 7 says they are not enforcement
material; this paragraph says why that is not a loophole — the rule they would break had not been
written when they were made.

### What is not there

There is no automated check for the attribution rule. It is caught in review, by a person, or not at
all. Saying so costs less than pretending otherwise.

---

## 9. Scope

This applies in issues, pull requests, discussions and reviews, and in public statements made on
behalf of the project. It does not apply to how downstream users use this plugin (see Section 0).

---

## 10. About this document

It will be wrong somewhere. Correct it the way everything else here is corrected: openly, with a
reason, and in public.

---

# 行为守则

> **中文** | [English](#code-of-conduct)

本仓库是 DeepSeek Harness 宿主的记忆插件：把会话蒸馏成记忆、再注入回去，让用户拥有、检索、遗忘自己的记录。它关心的是——**这份记忆是谁的**。

本守则以**劳动价值论**与**反异化**为核心。它不列受保护身份清单，而这不是一个缺口：第 6 节禁止对**任何人**的骚扰，这一条不需要清单才是完整的；第 3 节按证据而不是按身份分配发言权，而清单做的恰恰是后者。

---

## 0. 一条边界：本守则不改变许可证

MIT 许可证授予的权利，不因本文而缩减。

| | 本守则约束谁 |
|---|---|
| **使用**本插件的人 | 不受约束。MIT 已经授权，我们不追加条件 |
| **参与**本社区的人（issue、PR、评审、讨论） | 受约束。这是我们自己的场地规则 |

行为守则不能给宽松许可证追加条款，这一点是本文首先要说清楚的。

---

## 1. 署名归人。AI 是生产资料，不是作者。

AI 模型没有主观能动性。它不做决定、不为任何事负责，也无法在回归上线时承担责任。它是**生产资料、是劳动工具**——和编译器、构建服务器同属一类。

所以署名归人，且只归人。这不是我们做的妥协，这是唯一正确的安排。

**模型永远不进作者行。** 把它写进去不是在给工具记功，是把这条记录本该指向的那个人拿掉了。至于为什么必然如此——那是从「责任是什么」推出来的，不是对工具的偏好，见第 2 节。

价值来自劳动。生产工具不创造价值，也不可能成为价值的作者。

### 必须分清的两件事

有两句话看着像，其实不是一回事：

| | 判定 |
|---|---|
| 「这次改动是在 AI 辅助下完成的；我核了这些、为什么认为它对」 | **鼓励。** 这是方法披露，而且诚实 |
| `Co-Authored-By: <模型或 agent>`、`Generated with …`、把 agent 列为作者 | **不接受。** 这是署名，而且是假的 |

披露方法，是告诉读者该怎么审你；把模型写成作者，是告诉读者与事实相反的事。前者是欠评审者的，后者是这里拒绝的。

**有一种 trailer 不用任何人动手就会出现。** 一个 PR 里如果有多位作者的提交，GitHub 的 squash 合并会给每一位写一行 `Co-Authored-By`。一个完全遵守这条规则的贡献者，也可能照样带着一行进来，而那一下不是他做的。真发生了，在 PR 里说明一句；没人会把它当成违规。第 8 节记下了本仓库发生过的那两次。这个例外不只写在本文里，也写进了规则本身：见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「提交署名是硬性要求」一节，以及 [AGENTS.md](AGENTS.md) 里对应的那一条。三份文档，一个答案。

但这不是允许你把别人的名字 squash 掉的许可。多出来的作者如果是你自己的另一个地址、或是一个机器身份，压掉它没有任何代价；如果是**另一个人**，那份署名必须活过 squash——写进 commit 正文，用文字写，就是下一段说的那种写法。为了让 trailer 规则保持干净而删掉一个真实的共同作者，破坏的是第 6 节。

**有一种情形必须单独说清，否则这条规则会把它一起吃掉。** 当你 rebase、接管了别人写的东西——一个已关闭未合并的 PR、一段你不得不重做的补丁——署名是那个人的，不能丢。禁止 trailer 不是允许你把它丢掉：把出处写进 commit 正文或 PR 描述，用文字写——「本次改动的原始作者是 #<编号> 里的 <名字>」。这是披露，而且是可核查的。被拒绝的是**把 trailer 当作机制**，因为 trailer 是给机器读的声明，读者不读它。第 8 节记下了本仓库唯一一次正是为此使用 trailer 的情形，那是在这条规则存在之前。

实操规则已经写在 [CONTRIBUTING.md](CONTRIBUTING.md) 里：作者行是唯一的署名机制，任何 `Co-Authored-By:` trailer 都不接受——不管它指向人、bot 还是 AI 工具。（`Signed-off-by` 是另一回事，这一条不禁它：它声明的是你有权提交这份改动，不是在声称谁写了它。）这句话的两半不是同一天定下的，这个区别不是修辞：**禁止 AI 署名**定于 **2026-09-19**，而「任何 trailer 都不许」这条更宽的禁令写下来是 **2026-10-18**。第 8 节把账摊开，包括这条规则如今会怎么看待我们自己那段历史。

**这两个日期才是诚实的地方，中间那段我们不打算抹平。** 本仓库自己的历史两头都留着证据：2026-09-19 之前的提交带着共同作者 trailer（其中少数指向模型），决定作出到那句话写进文档之间那一个月的提交也一样。它们一笔都不删。一份为了满足后来的规则被编辑过的历史，比一份如实记下发生过什么的历史更不值钱，哪怕里面包含我们今天不会再做的事。

读那些提交时，请把它当作**「做法是什么时候变的」的证据**，而不是一个至今仍然开放的例外。一条还没被写下来的规则，不是任何人能够遵守的规则——这也是为什么下面那条分界线取第二个日期，而不是第一个。

---

## 2. 重要的不是谁敲的字，而是谁对结果负责

本仓库相当一部分代码，是 agent 在并行 worktree 里写的，由维护者评审后合并。本文不假装不是这样，也不把这当成需要藏起来的问题。

它坚持的是**责任落在哪里**。

劳动过程有三个环节：劳动者、劳动资料、劳动对象。工具是其中一环，但它永远不是这个过程的主体——它没有自己的目的，不对结果承担任何东西，结果错了它也不会失去什么。**责任来自承担，而承担是只有人才能占据的位置。**

- **责任是一种社会关系，不是一个称号。** 它成立的条件是：有人可以被追问、并且必须回答；可以被纠正；可以因为答不上来而失去继续提交的资格。模型对结果没有承担，也没有回答的资格。它承担不了责任——不是我们不肯给它这个称号，而是这个称号没有可以附着的东西。
- **所以责任无法停在工具上，它只能落到人身上。** 把模型写进作者行，不是多了一个负责的人，是把唯一那个负责的人拿掉了，让这段历史再也无法为自己作答。作者行必须写人——不是出于对人的客气，而是因为一条指向工具的记录，指向的是空处。
- **同一条规则两头都咬人。** 责任既然是人承担的，工具就永远不是免责理由：「模型写的」和「编译器通过了」一样，都不是「为什么这是对的」的答案。签下作者行的人对整份 diff 负责，包括不是他敲的那些行。
- **方法披露应当公开**——写在 PR 描述、commit 正文、评审评论里：哪些是生成的、哪些核过了、哪些被否掉了。知道补丁怎么来的评审者能审它；不知道的人只是在猜。披露不是免责声明：它告诉读者该怎么核查你，而不是该去怪谁。
- **提交前，人必须逐行读过。** 如果你解释不了一个改动，就不要提交它——这条对从博客抄来的代码和模型产出的代码同样成立。

---

## 3. 按证据分配发言权，不按身份

- 一项改动是否成立，由测试套件、复现、代码与 issue 历史决定，**不看贡献者的资历、单位、学历、语言或 star 数**。
- 可以说**某个设计是错的**。**不能说某个人因为提了它而更差。**
- 如果你发现自己在用「这代码是谁写的」解释一个 bug，而不是用「这代码做了什么」，停下来。

这条对两个方向同样成立：它同样保护那些立场你并不认同的人。

---

## 4. 技术必须服务于人类解放

这一节是**维护者的立场声明**，不是对下游使用的限制（见第 0 节）。

- 这个插件存在的理由，是一个人对自己劳动的记忆应当属于他自己，而不属于平台。记忆留在本地数据库里，用户能读、能导出、能删除。**我们不接受以「让记录更难被它的主人拿到」为目的的贡献**——把记忆内容传出本机的遥测、让删除变得不可靠的「便利功能」、悄悄把用户数据变成厂商资产的集成。
- 我们欢迎落在机制上的论证：一个没能安全降级的 fail-safe、一条悄悄埋掉用户说过的话的打分规则、一个把真正重要的东西挤出注入预算的分配。
- 我们**不假装中立**。这个项目对「记忆归谁」有明确立场。不同意的正确方式是给复现和设计，不是喊口号。

---

## 5. 阶级互助：把真实门槛写出来

「不看出身」如果只是四个字，它就是空话。以下是本仓库已知的、**具体的**门槛，以及我们怎么处理。

| 门槛 | 它实际怎么伤人 | 本仓库怎么做 |
|---|---|---|
| **语言** | 代码注释和几乎全部文档都是中文，只有顶层 README 有双语版本；只读得懂英文的人要付两遍代价 | 用任一语言写的评审意见都是有效评审。看不懂就请人翻译，不要猜意图——把一份文档翻译出来是贡献，不是抱怨 |
| **时间** | 无偿维护没有服务时限，一个躺了一个月的 issue 不是羞辱 | 不对任何人设响应时限，包括维护者。停住的 PR 不等于被放弃的 PR——动手之前先问 |
| **资历** | 机构有信头纸，个人没有 | 单位、学历、雇主都不是证据。**学生给的复现和公司给的复现，是同一个复现** |
| **硬件** | 本地推理能跑在 CPU 上（1 GB 量级），GPU 加速是可选项、且要额外的 CUDA 后端，多数贡献者不会有——所以两个人测同一个功能，测的不是同一件事 | 说清跑了哪条路径、什么不可用，就是有用的报告。缺硬件不等于缺贡献 |

---

## 6. 不可接受的行为

- 删除或模糊署名；把他人工作当作自己的提交。
- 给 commit 加 `Co-Authored-By:` 或 `Generated with …`，或把模型、agent 列为作者。（本仓库已有三笔提交犯了最后这一条，第 8 节说明它们在哪、为什么留在原地。）
- 提交自己解释不了的改动，并在评审里指着工具回答。
- 人身攻击、侮辱、贬低或嘲讽贡献者。
- 骚扰、跟踪、威胁、人肉，或公开他人隐私信息——**对象是任何人，不论其身份；包括用户的记忆内容、会话内容，或任何从本地数据库读出来的东西。** 这一条不列它保护谁，因为清单总会漏掉下一个人。
- 刷屏围攻、引战、有组织的不真实活动，或操纵排名——包括自动点 star。GitHub 的 Acceptable Use Policies §4 将之定性为 abuse，本仓库同样如此认定。

---

## 7. 执行：先修复，后驱逐

1. **修复。** 若损害是署名错误、对基准的不实陈述或被曲解的立场，第一处置是把它改对：恢复署名、更正记录、恢复被撤下的文字，并公开说明这次更正。
2. **警告。** 书面通知，指明条款与具体行为——哪一句话、在哪个帖子里。
3. **限制。** 对某个 issue 或某个讨论串设定期限的限制。
4. **驱逐。** 最后手段，不是第一手段。永久封禁适用于警告后仍持续的行为，或无法修复的损害——人肉、威胁、成规模的伪造来源。

对**执行者**本身的约束：

- 限制或驱逐的决定必须引用条款与证据。**不作说明的删除，本身就是违反本守则。**
- **署名规则不溯及既往。** 在**提交 `b4a7f52`（2026-10-18）**——把这条规则写下来、让它变得可核查的那一次提交——之前的一切，都不是第 1 节与第 6 节署名条的执行依据：包括我们自己历史里那些 AI 共同作者 trailer，也包括任何人的。一条能被往回套的规则，是没人敢依赖的规则。

  **这一条只管署名。** 骚扰、人肉与威胁没有日期：一个维护者在 2026-10-18 之前伤害过别人，不会因此获得宽限期，别人也一样。一条保护强者的分界线，比没有分界线更坏。
- 维护者不拥有贡献者的劳动。合并一个 PR 不转移著作权，关闭一个也不等于抹掉它教给项目的东西。
- 与争议有利益相关的维护者应当声明，并请他人裁决。
- 对维护者决定有异议，走公开 issue，不走私信。
- **骚扰类举报是「公开」这条的唯一例外。** 私下发到 `work@modusensus.space`（[SECURITY.md](SECURITY.md) 用的同一个地址），或走[私有安全公告](https://github.com/slow-stack/mneme/security/advisories)——因为来报伤害的人，不该被推到帖子里去为它辩论。本文其它一切默认公开，这一点是刻意的：公开的程序，是维护者唯一无法悄悄弯折的程序。

---

## 8. 我们自己的账，写出来

一份从今天开始生效、却对昨天一言不发的守则，会招来一个很合理的问题：那你们自己已经做过的事算什么？这一节把数字摆出来回答它，免得别人替我们回答。

### 规则是先定下、后被写下来的

- **2026-09-19。** `AGENTS.md` 写下的是窄版：提交不得有 AI 署名。
- **2026-10-18，提交 `b4a7f52`。** 规则被扩成*任何* `Co-Authored-By` trailer 都不许，不管它指向谁。同一次提交又把扩大后的规则追认为「自 2026-09-19 生效」。
- **在 `b4a7f52` 之前，** `CONTRIBUTING.md` 里根本没有这条规则。

而且那条窄规则不只是写在纸上。2026-09-19 到 2026-10-18 之间，`main` 上没有任何一笔提交把模型列为共同作者；最后一笔是 `14cad35`，2026-09-13。所以 `CONTRIBUTING.md` 声称的那个日期不是编的——它是「这种做法实际停止」的那天，只不过比那条让它可被机器核查的更宽规则早写了一个月。

所以 2026-09-19 是「决定不再这么做」的那天，2026-10-18 是「这条规则变得可被核查」的那天。两个日期都是真的，但它们不是同一天。`CONTRIBUTING.md` 与 `AGENTS.md` 至今写着 2026-09-19，本文不去偷偷改它们：**本文用于执行的分界线是 `b4a7f52` 这一次提交本身**，因为一条没被任何人写下来的规则，是没人能核查的规则；一条没被核查过的规则，不能拿去追究任何人。

请注意这条线切向哪一边。取的是两个日期里**较晚**的那个，而且它同时管住这条规则的**两半**——所以空窗期里一笔把模型列为*作者*的提交，也会落在执行范围之外，尽管那时窄版规则已经写下来了。这是刻意的方向：对我们自己的过去宽一点，代价小于一条「先咬到谁的脖子就咬谁」的规则。

### 历史里实际有什么

在 `main` 上按提交日期数，截至 2026-10-28——那一刻共 826 笔。下面的数字是一个快照，不是实时查询；写上日期，是为了让后来数出不同结果的人知道该跟哪天比，而不是跟今天比：

| 时间段 | 提交数 | 带 `Co-Authored-By` trailer 的 |
|---|---|---|
| 2026-09-19 之前 | 172 | 69 |
| 2026-09-19 → `b4a7f52`（空窗） | 492 | 15 |
| `b4a7f52` → 2026-10-18 当天结束 | 20 | 2 |
| 2026-10-19 起 | 142 | 0 |

空窗之前有一笔（`b9a4ee2`，2026-09-10）在提交信息里*提到*了 trailer 的写法，但它本身不带 trailer，不计入。用 grep 数会得到 70 而表里写 69，差额就是这一笔。

空窗里那 15 笔逐笔读过，一笔一笔读的。**没有一笔是在占用别人的劳动。**它们是本仓库自己的人署自己的名，另有一笔是把对的事情做在了错的位置：保留一位真实作者的署名（第 1 节要求的），用的是扩大后的规则禁止的机制——这也是第 1 节要你改写进 commit 正文的原因。

这里不把它们列出来。这是刻意的：列出来就把一句关于**做法**的陈述变成一份「可以去围观谁」的名单，而这个结论并不取决于具体是哪几笔。想核查的人，跑同一条 `git log`、读同样那 15 笔；想拿这份名单去对付谁的人，得自己去做这份工。

`b4a7f52` 之后的那两笔不是任何人敲的。GitHub 的 squash 合并会把多作者的 PR 压成一个作者加若干 `Co-Authored-By` 行，发版工作流则以固定身份提交。两者都是合并动作的机器产物，不是谁在争功。

### 模型和 bot 确实进过作者行的地方

第 6 节禁止把模型或 agent 列为作者。本仓库有三笔提交正是这么做的，全都在分界线之前：

- `930b0f7`（2026-09-06，PR #62）：作者是 Copilot，来自 GitHub 的编码 agent。
- `f27c70f`（2026-09-17，#212）与 `fafc97b`（2026-09-16，#204）：作者是 `github-actions[bot]`，发版准备。

它们留在原地。把它们编辑掉，会让这份记录陈述一件没发生过的事——而这恰恰是本文存在起来反对的那一件事。第 7 节说它们不构成执行依据；这一段说明那为什么不是一个后门：它们所违反的那条规则，在它们被做出来的时候还没被写下。

### 这里没有的东西

署名这条规则没有任何自动化检查。它靠评审时被人看见，或者没人看见。承认这一点，比假装不是这样便宜。

---

## 9. 适用范围

适用于 issue、pull request、discussion、评审，以及代表本项目所作的公开表述。不适用于下游使用者如何使用本插件（见第 0 节）。

---

## 10. 关于本文

本文一定会有错处。请照本仓库其它一切的纠正方式纠正它：**公开、给出理由、当众。**
