import React from "react";
import { SettingsDropdown, SettingsToggle } from "../../components/settings-controls.jsx";
import { WorkerIcon } from "../../components/worker-ui.jsx";
import { ApiWorkerSettings } from "../api-workers/api-worker-settings.jsx";

export function SettingsView({
  active,
  api,
  status,
  busy,
  copyLink,
  rotateLink,
  refresh,
  notify,
  reportApiWorkerError,
  managerSettings,
  setManagerSettings,
  settingsBusy,
  changeAppBackground,
  restoreAppBackground,
  globalRulesDraft,
  setGlobalRulesDraft,
  GLOBAL_RULES_TEMPLATE,
  saveManagerSetting,
  chatWidthInput,
  setChatWidthInput,
  commitChatWidthInput,
  chatHeightInput,
  setChatHeightInput,
  commitChatHeightInput,
  profileCardHeightInput,
  setProfileCardHeightInput,
  commitProfileCardHeightInput,
  FONT_OPTIONS,
  FONT_ROLE_OPTIONS,
  FONT_WEIGHT_LABELS,
  workerPackDraft,
  setWorkerPackDraft,
  showWorkerPackCreator,
  setShowWorkerPackCreator,
  workerPackDeleteArmed,
  selectWorkerImagePack,
  deleteWorkerImagePack,
  createWorkerImagePack,
  changeWorkerImage,
  restoreWorkerImage,
  restoreManagerSettings
}) {
  const selectedFont = FONT_OPTIONS.find((option) => option.value === managerSettings.fontFamily) || FONT_OPTIONS[0];
  const selectedHeadingFont = FONT_OPTIONS.find((option) => option.value === managerSettings.headingFontFamily);
  const selectedMonoFont = FONT_OPTIONS.find((option) => option.value === managerSettings.monoFontFamily);
  const workerSettingItems = [
    { state: "idle", title: "Đang rảnh", description: "Hiện khi profile online và đang chờ việc." },
    { state: "working", title: "Đang làm việc", description: "Hiện khi ChatGPT đang xử lý hoặc hoàn tất turn." },
    { state: "hung", title: "Mất kết nối", description: "Hiện khi extension/profile mất heartbeat." }
  ];
  const selectedWorkerPack = managerSettings.workerImagePacks.find((pack) => pack.id === managerSettings.selectedWorkerPackId) || null;
  const workerPackOptions = [
    { value: "default", label: "Bộ mặc định", hint: "Ảnh worker đi kèm CodexPro" },
    ...managerSettings.workerImagePacks.map((pack) => ({
      value: pack.id,
      label: pack.name,
      hint: `${Object.values(pack.imageDataUrls || {}).filter(Boolean).length}/3 ảnh đã tải lên`
    }))
  ];

  return (
        <div className="settings-view" hidden={!active}>
          <section className="connection-card" id="connection">
            <div className="connection-copy">
              <p className="eyebrow">MCP SERVER URL</p>
              <h2>Kết nối ChatGPT</h2>
              <p>Link đã gắn token riêng của CodexPro. Chọn <b>Server URL</b> và <b>No Auth</b>.</p>
            </div>
            <div className="link-box">
              <code>{status?.mcpLink || "Chưa có link MCP"}</code>
              <button className="copy-button" onClick={copyLink} disabled={!status?.mcpLink}>Copy</button>
            </div>
            <div className="link-actions">
              <button className="button secondary" onClick={copyLink} disabled={!status?.mcpLink}>Copy link</button>
              <button className="button danger-quiet" onClick={rotateLink} disabled={Boolean(busy)}>{busy === "rotate" ? "Đang tạo..." : "Tạo token + link mới"}</button>
              <button className="text-button" onClick={() => api.openExternal("https://chatgpt.com/plugins?q=CodexPro")}>Mở Plugins ChatGPT ↗</button>
            </div>
          </section>

          <ApiWorkerSettings onChanged={() => refresh(false)} notify={notify} onError={reportApiWorkerError} />

          <section className="settings-panel app-background-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">APP WALLPAPER</p>
                <h2>Hình nền ứng dụng</h2>
                <p className="section-note">Dùng PNG, JPG, WEBP hoặc GIF làm hình nền toàn app. GIF sẽ tự phát; giao diện phủ lớp tối và blur để chữ vẫn dễ đọc.</p>
              </div>
              <span className={`wallpaper-status-badge ${managerSettings.appBackgroundDataUrl ? "is-active" : ""}`}>{managerSettings.appBackgroundDataUrl ? "ĐANG DÙNG" : "MẶC ĐỊNH"}</span>
            </div>
            <div className="app-background-layout">
              <div className={`app-background-preview ${managerSettings.appBackgroundDataUrl ? "has-image" : ""}`}>
                {managerSettings.appBackgroundDataUrl
                  ? <img src={managerSettings.appBackgroundDataUrl} alt="" aria-hidden="true" style={{ filter: `blur(${managerSettings.appBackgroundBlur}px)` }} />
                  : <div className="app-background-empty"><strong>Chưa có hình nền</strong><span>Chọn ảnh hoặc GIF để xem trước.</span></div>}
                {managerSettings.appBackgroundDataUrl && <div className="app-background-preview-shade" style={{ backgroundColor: `rgba(4, 7, 12, ${managerSettings.appBackgroundDim / 100})` }} />}
                {managerSettings.appBackgroundDataUrl && <div className="app-background-preview-glass"><strong>CodexPro</strong><span>Glass wallpaper preview</span></div>}
              </div>
              <div className="app-background-controls">
                <div className="app-background-actions">
                  <button type="button" className="button primary" disabled={Boolean(settingsBusy)} onClick={() => void changeAppBackground()}>{settingsBusy === "background" ? "Đang chọn…" : managerSettings.appBackgroundDataUrl ? "Đổi ảnh / GIF" : "Chọn ảnh / GIF"}</button>
                  <button type="button" className="button ghost" disabled={Boolean(settingsBusy) || !managerSettings.appBackgroundDataUrl} onClick={() => void restoreAppBackground()}>Xóa nền</button>
                </div>
                <div className="app-background-control">
                  <div className="app-background-control-head"><label htmlFor="app-background-blur">Độ mờ hình nền</label><strong>{managerSettings.appBackgroundBlur}px</strong></div>
                  <input id="app-background-blur" className="settings-range" type="range" min="0" max="24" step="1" value={managerSettings.appBackgroundBlur} onChange={(event) => setManagerSettings((current) => ({ ...current, appBackgroundBlur: Number(event.target.value) }))} onPointerUp={(event) => void saveManagerSetting({ appBackgroundBlur: Number(event.currentTarget.value) }, "Đã lưu độ mờ hình nền")} onKeyUp={(event) => void saveManagerSetting({ appBackgroundBlur: Number(event.currentTarget.value) }, "Đã lưu độ mờ hình nền")} />
                </div>
                <div className="app-background-control">
                  <div className="app-background-control-head"><label htmlFor="app-background-dim">Lớp tối phủ nền</label><strong>{managerSettings.appBackgroundDim}%</strong></div>
                  <input id="app-background-dim" className="settings-range" type="range" min="0" max="85" step="1" value={managerSettings.appBackgroundDim} onChange={(event) => setManagerSettings((current) => ({ ...current, appBackgroundDim: Number(event.target.value) }))} onPointerUp={(event) => void saveManagerSetting({ appBackgroundDim: Number(event.currentTarget.value) }, "Đã lưu độ tối hình nền")} onKeyUp={(event) => void saveManagerSetting({ appBackgroundDim: Number(event.currentTarget.value) }, "Đã lưu độ tối hình nền")} />
                </div>
                <small className="app-background-help">Tối đa 25 MB · ảnh được copy vào dữ liệu CodexPro nên không phụ thuộc file gốc.</small>
              </div>
            </div>
          </section>

          <section className="settings-panel global-rules-panel">
            <div className="settings-panel-head global-rules-head">
              <div>
                <p className="eyebrow">GLOBAL MCP RULES</p>
                <h2>Rule bắt buộc cho mọi repo</h2>
                <p className="section-note">CodexPro sẽ nạp <code>~/.codexpro/CODEXPRO.md</code> trước rule riêng của repo/dự án mỗi khi bắt đầu hoặc mở workspace.</p>
              </div>
              <span className="global-rules-badge">BẮT BUỘC</span>
            </div>
            <textarea
              className="global-rules-editor"
              value={globalRulesDraft}
              maxLength={30000}
              spellCheck={false}
              aria-label="CodexPro global rules"
              disabled={settingsBusy === "save"}
              onChange={(event) => setGlobalRulesDraft(event.target.value)}
              placeholder={GLOBAL_RULES_TEMPLATE}
            />
            <div className="global-rules-actions">
              <span>{globalRulesDraft.length.toLocaleString("vi-VN")} / 30.000 ký tự · áp dụng toàn bộ repo/dự án</span>
              <button type="button" className="button ghost" disabled={settingsBusy === "save"} onClick={() => setGlobalRulesDraft(GLOBAL_RULES_TEMPLATE)}>Dùng template</button>
              <button type="button" className="button primary" disabled={settingsBusy === "save" || globalRulesDraft === managerSettings.globalRules} onClick={() => void saveManagerSetting({ globalRules: globalRulesDraft }, "Đã lưu CODEXPRO.md")}>{settingsBusy === "save" ? "Đang lưu…" : "Lưu rule"}</button>
            </div>
          </section>

          <section className="settings-panel subagent-limit-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">AGENT EXECUTION</p>
                <h2>Số lượng subagent chạy</h2>
                <p className="section-note">Agent chính luôn chạy một phiên. Setting này giới hạn số agent con CodexPro được phép gọi trong mỗi handoff.</p>
              </div>
              <span className="subagent-test-badge">TEST CAP</span>
            </div>
            <div className="subagent-limit-row">
              <div className="subagent-limit-copy">
                <strong>Tối đa mỗi handoff</strong>
                <span>Đang khóa 1 subagent để kiểm thử ổn định. Explore dùng slot duy nhất; Gemini scout sẽ được bỏ qua.</span>
              </div>
              <div className="settings-number-field subagent-limit-field" aria-label="Số subagent tối đa">
                <input type="number" min="1" max="1" value={managerSettings.maxSubagents} readOnly aria-readonly="true" />
                <span>agent</span>
              </div>
            </div>
            <div className="subagent-limit-meter" aria-hidden="true">
              <span className="is-active"><b>1</b><small>Explore</small></span>
              <i />
              <span className="is-locked"><b>2+</b><small>Đang khóa</small></span>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">CHAT POPUP</p>
                <h2>Độ rộng popup chat</h2>
                <p className="section-note">Tăng hoặc giảm chiều rộng cửa sổ Chat. Giá trị vẫn tự co theo màn hình nhỏ.</p>
              </div>
              <div className="settings-number-field">
                <input
                  type="number"
                  min="720"
                  max="1600"
                  step="20"
                  inputMode="numeric"
                  aria-label="Độ rộng popup chat"
                  value={chatWidthInput}
                  disabled={settingsBusy === "save"}
                  onChange={(event) => setChatWidthInput(event.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={commitChatWidthInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setChatWidthInput(String(managerSettings.chatWidth));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span>px</span>
              </div>
            </div>
            <SettingsToggle
              checked={managerSettings.showChatConversationSelector !== false}
              disabled={settingsBusy === "save"}
              title="Hiện mục Đoạn chat"
              hint="Tắt để ẩn bộ chọn hội thoại trong popup Chat."
              onChange={(value) => void saveManagerSetting({ showChatConversationSelector: value }, value ? "Đã hiện mục Đoạn chat" : "Đã ẩn mục Đoạn chat")}
            />
            <div className="width-control">
              <button
                type="button"
                className="setting-step-button"
                aria-label="Giảm độ rộng popup"
                disabled={settingsBusy === "save" || managerSettings.chatWidth <= 720}
                onClick={() => void saveManagerSetting({ chatWidth: Math.max(720, managerSettings.chatWidth - 40) }, "Đã giảm độ rộng popup")}
              >−</button>
              <input
                className="settings-range"
                type="range"
                min="720"
                max="1600"
                step="20"
                value={managerSettings.chatWidth}
                onChange={(event) => setManagerSettings((current) => ({ ...current, chatWidth: Number(event.target.value) }))}
                onPointerUp={(event) => void saveManagerSetting({ chatWidth: Number(event.currentTarget.value) }, "Đã lưu độ rộng popup")}
                onKeyUp={(event) => void saveManagerSetting({ chatWidth: Number(event.currentTarget.value) }, "Đã lưu độ rộng popup")}
              />
              <button
                type="button"
                className="setting-step-button"
                aria-label="Tăng độ rộng popup"
                disabled={settingsBusy === "save" || managerSettings.chatWidth >= 1600}
                onClick={() => void saveManagerSetting({ chatWidth: Math.min(1600, managerSettings.chatWidth + 40) }, "Đã tăng độ rộng popup")}
              >＋</button>
            </div>
            <div className="width-scale"><span>720px</span><span>Mặc định 940px</span><span>1600px</span></div>
            <div className="chat-width-preview"><div style={{ width: `${Math.max(42, Math.min(100, managerSettings.chatWidth / 16))}%` }}><span>Chat popup</span><small>{managerSettings.chatWidth}px</small></div></div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">CHAT CONTENT</p>
                <h2>Chiều cao khung chat bên trong</h2>
                <p className="section-note">Chỉnh chiều cao vùng “Tin nhắn gần nhất” trong popup Chat. Nội dung dài vẫn cuộn độc lập bên trong khung.</p>
              </div>
              <div className="settings-number-field">
                <input
                  type="number"
                  min="180"
                  max="700"
                  step="10"
                  inputMode="numeric"
                  aria-label="Chiều cao khung chat bên trong"
                  value={chatHeightInput}
                  disabled={settingsBusy === "save"}
                  onChange={(event) => setChatHeightInput(event.target.value.replace(/[^0-9]/g, ""))}
                  onBlur={commitChatHeightInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setChatHeightInput(String(managerSettings.chatHeight));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span>px</span>
              </div>
            </div>
            <div className="width-control">
              <button
                type="button"
                className="setting-step-button"
                aria-label="Giảm chiều cao khung chat"
                disabled={settingsBusy === "save" || managerSettings.chatHeight <= 180}
                onClick={() => void saveManagerSetting({ chatHeight: Math.max(180, managerSettings.chatHeight - 20) }, "Đã giảm chiều cao khung chat")}
              >−</button>
              <input
                className="settings-range chat-height-range"
                type="range"
                min="180"
                max="700"
                step="10"
                value={managerSettings.chatHeight}
                onChange={(event) => setManagerSettings((current) => ({ ...current, chatHeight: Number(event.target.value) }))}
                onPointerUp={(event) => void saveManagerSetting({ chatHeight: Number(event.currentTarget.value) }, "Đã lưu chiều cao khung chat")}
                onKeyUp={(event) => void saveManagerSetting({ chatHeight: Number(event.currentTarget.value) }, "Đã lưu chiều cao khung chat")}
              />
              <button
                type="button"
                className="setting-step-button"
                aria-label="Tăng chiều cao khung chat"
                disabled={settingsBusy === "save" || managerSettings.chatHeight >= 700}
                onClick={() => void saveManagerSetting({ chatHeight: Math.min(700, managerSettings.chatHeight + 20) }, "Đã tăng chiều cao khung chat")}
              >＋</button>
            </div>
            <div className="width-scale"><span>180px</span><span>Mặc định 330px</span><span>700px</span></div>
            <div className="chat-height-preview">
              <div style={{ height: `${Math.max(34, Math.min(100, managerSettings.chatHeight / 7))}%` }}>
                <span>Tin nhắn gần nhất</span><small>{managerSettings.chatHeight}px</small>
              </div>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head profile-layout-setting-head">
              <div>
                <p className="eyebrow">PROFILE LAYOUT</p>
                <h2>Bố cục profile đã kết nối</h2>
                <p className="section-note">Chọn danh sách ngang gọn gàng hoặc thẻ dọc với ảnh worker lớn. Thẻ dọc hiển thị tối đa 4 profile mỗi hàng.</p>
              </div>
              <div className="profile-layout-controls">
                <div className="profile-layout-select">
                  <label>Kiểu hiển thị</label>
                  <SettingsDropdown
                    value={managerSettings.profileLayout}
                    options={[
                      { value: "rows", label: "Danh sách ngang", hint: "Gọn, ưu tiên thông tin profile" },
                      { value: "cards", label: "Thẻ dọc", hint: "Ảnh worker lớn, tối đa 4 thẻ mỗi hàng" }
                    ]}
                    disabled={settingsBusy === "save"}
                    ariaLabel="Chọn bố cục profile"
                    onChange={(value) => void saveManagerSetting({ profileLayout: value }, value === "cards" ? "Đã chuyển sang thẻ dọc" : "Đã chuyển sang danh sách ngang")}
                  />
                </div>
                <div className="profile-border-style-select">
                  <label>Viền worker đang hoạt động</label>
                  <SettingsDropdown
                    value={managerSettings.workingBorderStyle}
                    options={[
                      { value: "shine", label: "Ánh sáng xoay", hint: "Kiểu viền cam xoay hiện tại" },
                      { value: "mint", label: "Glow mint xanh", hint: "Mint → xanh lam chạy quanh viền" },
                      { value: "beam", label: "Tia chạy quanh viền", hint: "Border Beam gọn theo Ant Design" }
                    ]}
                    disabled={settingsBusy === "save"}
                    ariaLabel="Chọn kiểu viền worker đang hoạt động"
                    onChange={(value) => void saveManagerSetting({ workingBorderStyle: value }, value === "beam" ? "Đã chọn viền tia chạy" : value === "mint" ? "Đã chọn viền glow mint xanh" : "Đã chọn viền ánh sáng xoay")}
                  />
                </div>
                <div className="profile-card-height-control">
                  <label>Chiều cao thẻ dọc</label>
                  <div className="profile-card-height-field">
                    <button type="button" className="setting-step-button" aria-label="Giảm chiều cao thẻ profile" disabled={settingsBusy === "save" || managerSettings.profileCardHeight <= 390} onClick={() => void saveManagerSetting({ profileCardHeight: Math.max(390, managerSettings.profileCardHeight - 20) }, "Đã giảm chiều cao thẻ profile")}>−</button>
                    <div className="settings-number-field profile-card-height-number">
                      <input
                        type="number"
                        min="390"
                        max="760"
                        step="10"
                        inputMode="numeric"
                        aria-label="Chiều cao thẻ profile"
                        value={profileCardHeightInput}
                        disabled={settingsBusy === "save"}
                        onChange={(event) => setProfileCardHeightInput(event.target.value.replace(/[^0-9]/g, ""))}
                        onBlur={commitProfileCardHeightInput}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setProfileCardHeightInput(String(managerSettings.profileCardHeight));
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <span>px</span>
                    </div>
                    <button type="button" className="setting-step-button" aria-label="Tăng chiều cao thẻ profile" disabled={settingsBusy === "save" || managerSettings.profileCardHeight >= 760} onClick={() => void saveManagerSetting({ profileCardHeight: Math.min(760, managerSettings.profileCardHeight + 20) }, "Đã tăng chiều cao thẻ profile")}>＋</button>
                  </div>
                  <small>390–760 px · áp dụng cho thẻ dọc</small>
                </div>
              </div>
            </div>
            <div className={`profile-layout-preview is-${managerSettings.profileLayout === "cards" ? "card" : "row"} working-border-${managerSettings.workingBorderStyle}`} aria-hidden="true">
              {["idle", "working", "idle", "hung"].map((state, index) => (
                <span className={`profile-layout-preview-item is-${state}`} key={`${state}-${index}`}>
                  <span className="worker-active-border" />
                  <WorkerIcon state={state} customImages={managerSettings.workerImageDataUrls} />
                  <i />
                </span>
              ))}
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">TYPOGRAPHY</p>
                <h2>Font chữ theo thành phần</h2>
                <p className="section-note">Chọn font riêng cho nội dung, tiêu đề và phần kỹ thuật. Có thể để các nhóm dùng chung một font.</p>
              </div>
            </div>
            <div className="font-role-grid">
              <div className="font-setting-row">
                <label>Nội dung & control</label>
                <SettingsDropdown
                  value={managerSettings.fontFamily}
                  options={FONT_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font nội dung và control"
                  onChange={(value) => void saveManagerSetting({ fontFamily: value }, "Đã đổi font nội dung")}
                />
                <div className="font-preview" style={{ fontFamily: selectedFont.css, fontSize: `${managerSettings.fontSize}px` }}>Aa Bb Cc · Nội dung tiếng Việt: Đặng, Nguyễn, Trường · 0123456789</div>
              </div>
              <div className="font-setting-row">
                <label>Tiêu đề</label>
                <SettingsDropdown
                  value={managerSettings.headingFontFamily}
                  options={FONT_ROLE_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font tiêu đề"
                  onChange={(value) => void saveManagerSetting({ headingFontFamily: value }, value === "inherit" ? "Tiêu đề dùng font nội dung" : "Đã đổi font tiêu đề")}
                />
                <div className="font-preview is-title" style={{ fontFamily: selectedHeadingFont?.css || selectedFont.css }}>CodexPro · Tiêu đề giao diện</div>
              </div>
              <div className="font-setting-row">
                <label>Code · ID · log</label>
                <SettingsDropdown
                  value={managerSettings.monoFontFamily}
                  options={FONT_ROLE_OPTIONS}
                  disabled={settingsBusy === "save"}
                  ariaLabel="Chọn font code ID và log"
                  onChange={(value) => void saveManagerSetting({ monoFontFamily: value }, value === "inherit" ? "Code và log dùng font nội dung" : "Đã đổi font code và log")}
                />
                <div className="font-preview is-mono" style={{ fontFamily: selectedMonoFont?.css || selectedFont.css }}>cpt_task_id · 127.0.0.1:8793 · npm run build</div>
              </div>
            </div>
            <div className="font-size-setting-row">
              <label>Cỡ chữ chung</label>
              <div className="width-control">
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Giảm cỡ chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontSize <= 12}
                  onClick={() => void saveManagerSetting({ fontSize: Math.max(12, managerSettings.fontSize - 1) }, "Đã giảm cỡ chữ")}
                >−</button>
                <input
                  className="settings-range"
                  type="range"
                  min="12"
                  max="18"
                  step="1"
                  value={managerSettings.fontSize}
                  onChange={(event) => setManagerSettings((current) => ({ ...current, fontSize: Number(event.target.value) }))}
                  onPointerUp={(event) => void saveManagerSetting({ fontSize: Number(event.currentTarget.value) }, "Đã lưu cỡ chữ")}
                  onKeyUp={(event) => void saveManagerSetting({ fontSize: Number(event.currentTarget.value) }, "Đã lưu cỡ chữ")}
                />
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Tăng cỡ chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontSize >= 18}
                  onClick={() => void saveManagerSetting({ fontSize: Math.min(18, managerSettings.fontSize + 1) }, "Đã tăng cỡ chữ")}
                >＋</button>
              </div>
              <div className="font-size-value"><strong>{managerSettings.fontSize}</strong><span>px · cỡ chữ cơ bản</span></div>
            </div>
            <div className="font-size-setting-row font-weight-setting-row">
              <label>Độ đậm chữ chung</label>
              <div className="width-control">
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Giảm độ đậm chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontWeight <= 400}
                  onClick={() => void saveManagerSetting({ fontWeight: Math.max(400, managerSettings.fontWeight - 100) }, "Đã giảm độ đậm chữ")}
                >−</button>
                <input
                  className="settings-range font-weight-range"
                  type="range"
                  min="400"
                  max="700"
                  step="100"
                  aria-label="Độ đậm chữ chung"
                  value={managerSettings.fontWeight}
                  onChange={(event) => setManagerSettings((current) => ({ ...current, fontWeight: Number(event.target.value) }))}
                  onPointerUp={(event) => void saveManagerSetting({ fontWeight: Number(event.currentTarget.value) }, "Đã lưu độ đậm chữ")}
                  onKeyUp={(event) => void saveManagerSetting({ fontWeight: Number(event.currentTarget.value) }, "Đã lưu độ đậm chữ")}
                />
                <button
                  type="button"
                  className="setting-step-button"
                  aria-label="Tăng độ đậm chữ"
                  disabled={settingsBusy === "save" || managerSettings.fontWeight >= 700}
                  onClick={() => void saveManagerSetting({ fontWeight: Math.min(700, managerSettings.fontWeight + 100) }, "Đã tăng độ đậm chữ")}
                >＋</button>
              </div>
              <div className="font-size-value"><strong>{managerSettings.fontWeight}</strong><span>{FONT_WEIGHT_LABELS[managerSettings.fontWeight] || "Custom"} · độ đậm cơ bản</span></div>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-head">
              <div>
                <p className="eyebrow">WORKER APPEARANCE</p>
                <h2>Bộ ảnh worker</h2>
                <p className="section-note">Tạo nhiều bộ, tải ảnh cho từng trạng thái rồi đổi bộ đang dùng bất cứ lúc nào. Hỗ trợ PNG, JPG, GIF, WEBP tối đa 10 MB.</p>
              </div>
            </div>
            <div className="worker-pack-toolbar">
              <div className="worker-pack-select">
                <label>Bộ đang dùng</label>
                <SettingsDropdown
                  value={managerSettings.selectedWorkerPackId}
                  options={workerPackOptions}
                  disabled={Boolean(settingsBusy)}
                  ariaLabel="Chọn bộ ảnh worker"
                  onChange={(value) => void selectWorkerImagePack(value)}
                />
              </div>
              <div className="worker-pack-preview-strip" aria-label="Xem trước bộ ảnh đang dùng">
                {workerSettingItems.map((item) => <WorkerIcon key={item.state} state={item.state} customImages={managerSettings.workerImageDataUrls} />)}
              </div>
              <div className="worker-pack-actions">
                <button type="button" className="button secondary" onClick={() => { setWorkerPackDraft(`Bộ worker ${managerSettings.workerImagePacks.length + 1}`); setShowWorkerPackCreator(true); }} disabled={Boolean(settingsBusy)}>＋ Tạo bộ mới</button>
                <button type="button" className={`button danger-quiet ${workerPackDeleteArmed === selectedWorkerPack?.id ? "is-armed" : ""}`} onClick={() => void deleteWorkerImagePack()} disabled={Boolean(settingsBusy) || !selectedWorkerPack}>{workerPackDeleteArmed === selectedWorkerPack?.id ? "Xác nhận xóa" : "Xóa bộ"}</button>
              </div>
            </div>
            {showWorkerPackCreator && (
              <div className="worker-pack-creator">
                <input
                  autoFocus
                  value={workerPackDraft}
                  maxLength={60}
                  placeholder="Tên bộ ảnh worker"
                  onChange={(event) => setWorkerPackDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createWorkerImagePack();
                    if (event.key === "Escape") { setShowWorkerPackCreator(false); setWorkerPackDraft(""); }
                  }}
                />
                <button type="button" className="button primary" onClick={() => void createWorkerImagePack()} disabled={Boolean(settingsBusy) || !workerPackDraft.trim()}>Tạo bộ</button>
                <button type="button" className="button ghost" onClick={() => { setShowWorkerPackCreator(false); setWorkerPackDraft(""); }} disabled={Boolean(settingsBusy)}>Hủy</button>
              </div>
            )}
            {!selectedWorkerPack && <p className="worker-pack-help">Bộ mặc định chỉ để sử dụng. Hãy bấm <strong>Tạo bộ mới</strong> để upload ảnh riêng.</p>}
            <div className="worker-settings-grid">
              {workerSettingItems.map((item) => {
                const customized = Boolean(selectedWorkerPack?.imageDataUrls?.[item.state]);
                const loading = settingsBusy === `worker:${item.state}`;
                return (
                  <article className="worker-setting-card" key={item.state}>
                    <WorkerIcon state={item.state} customImages={managerSettings.workerImageDataUrls} />
                    <div className="worker-setting-copy">
                      <div><strong>{item.title}</strong>{customized && <span className="customized-badge">TÙY CHỈNH</span>}</div>
                      <p>{item.description}</p>
                    </div>
                    <div className="worker-setting-actions">
                      <button type="button" className="button secondary" onClick={() => void changeWorkerImage(item.state)} disabled={Boolean(settingsBusy) || !selectedWorkerPack}>{loading ? "Đang chọn…" : "Chọn ảnh"}</button>
                      <button type="button" className="button ghost" onClick={() => void restoreWorkerImage(item.state)} disabled={Boolean(settingsBusy) || !customized}>Mặc định</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <div className="settings-footer">
            <span>Cài đặt được lưu trong dữ liệu CodexPro trên máy này.</span>
            <button type="button" className="button danger-quiet" onClick={() => void restoreManagerSettings()} disabled={Boolean(settingsBusy)}>{settingsBusy === "reset" ? "Đang khôi phục…" : "Khôi phục tất cả mặc định"}</button>
          </div>
        </div>
  );
}
