import { useCallback } from "react";
import { projectSelectionChanged } from "../chat-project.js";
import { ALL_ALLOWED_WORKSPACES } from "../project-dropdown.jsx";
import { NEW_CHAT_TARGET } from "../features/chat/chat-dropdown.jsx";

export function useProjectActions({
  api,
  projects,
  requestProjectRoots,
  managerSettings,
  requestTargetsRef,
  setProjects,
  setInspection,
  setBusy,
  setError,
  setRequestProjectRoots,
  setManagerSettings,
  setRequestTargets,
  setRequestResponses,
  setRequestSendErrors,
  setRequestSendEvidence,
  applyManagerSettings,
  resetChatViewport,
  notify
}) {
  const projectRootForProfile = useCallback((profile) => {
    const requested = String(requestProjectRoots[profile.profile_id] || managerSettings.repoSelections?.[profile.profile_id] || "");
    if (requested === ALL_ALLOWED_WORKSPACES) return ALL_ALLOWED_WORKSPACES;
    const exact = projects.find((project) => project.root.toLowerCase() === requested.toLowerCase());
    if (exact) return exact.root;
    const currentWorkspace = String(profile.current_workspace_root || "");
    return projects.find((project) => project.root.toLowerCase() === currentWorkspace.toLowerCase())?.root
      || projects.find((project) => project.active)?.root
      || projects[0]?.root
      || "";
  }, [managerSettings.repoSelections, projects, requestProjectRoots]);

  const selectProjectForProfile = useCallback((profileId, root) => {
    setRequestProjectRoots((current) => ({ ...current, [profileId]: root }));
    setManagerSettings((current) => ({ ...current, repoSelections: { ...(current.repoSelections || {}), [profileId]: root } }));
    void api.saveManagerSettings({ repoSelections: { [profileId]: root } })
      .then(applyManagerSettings)
      .catch((err) => setRequestSendErrors((current) => ({ ...current, [profileId]: err?.message || String(err) })));
  }, [api, applyManagerSettings, setManagerSettings, setRequestProjectRoots, setRequestSendErrors]);

  const changeProjectForProfile = useCallback((profile, root) => {
    const profileId = profile.profile_id;
    const previousRoot = projectRootForProfile(profile);
    selectProjectForProfile(profileId, root);
    if (!projectSelectionChanged(previousRoot, root)) return;

    requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: NEW_CHAT_TARGET };
    setRequestTargets((current) => ({ ...current, [profileId]: NEW_CHAT_TARGET }));
    setRequestResponses((current) => ({
      ...current,
      [profileId]: {
        visible: true,
        loading: false,
        error: "",
        conversationId: NEW_CHAT_TARGET,
        text: "",
        messages: [],
        busy: false
      }
    }));
    setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profileId]: null }));
    resetChatViewport(profileId, { clearAnchor: false });
    notify("Đã đổi dự án · tin nhắn tiếp theo sẽ mở chat mới");
  }, [notify, projectRootForProfile, requestTargetsRef, resetChatViewport, selectProjectForProfile, setRequestResponses, setRequestSendErrors, setRequestSendEvidence, setRequestTargets]);

  const addProject = useCallback(async () => {
    const root = await api.chooseProject();
    if (!root) return;
    setBusy("add");
    try {
      setProjects(await api.addProject(root));
      notify("Đã thêm dự án");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [api, notify, setBusy, setError, setProjects]);

  const inspect = useCallback(async (project) => {
    setBusy(project.root);
    setError("");
    try {
      const result = await api.inspectProject(project.root);
      setInspection({ project, result });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [api, setBusy, setError, setInspection]);

  return {
    addProject,
    inspect,
    projectRootForProfile,
    selectProjectForProfile,
    changeProjectForProfile
  };
}
