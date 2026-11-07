// View builder — a phone-first rebuild of mneme's own panel.
//
// Top level: three sections in the app's own `tabs` bar (equal columns, one
// line, local switching). The app's tab bar needs 80dp per tab, so four tabs
// wrap on a phone-width panel; three fit. 运行状态 lives inside the settings tab,
// and so does the conflict queue (that is where its entry point sits).
// Because tabs switch locally, every section's data is loaded and pushed together.
import { entitySection } from "./entity.js";
import { memorySection } from "./memory.js";
import { settingsTab } from "./settings.js";
import { notices } from "./common.js";

export function buildView(state) {
  return {
    v: 2,
    type: "stack",
    accent: "app",
    children: [
      ...notices(state),
      {
        type: "tabs",
        items: [
          { label: "记忆", children: memorySection(state) },
          { label: "实体", children: entitySection(state) },
          { label: "设置", children: settingsTab(state) },
        ],
      },
    ],
  };
}
