import { appendCacheBust, buildGenerationPayload, validateGenerationInput } from './core.mjs';
import { resetOutput, setError, setGenerateBusy } from './view.mjs';

export function createGenerationController({ els, state, flora, accounts }) {
  function bind() {
    els.generateBtn.addEventListener('click', async () => {
      setError(els, '');
      resetOutput(els);
      const account = accounts.activeAccount();
      const payload = buildGenerationPayload({
        accountId: account?.id || '',
        imageHandle: state.localImageHandle,
        imageUrl: els.imageUrl.value,
        prompt: els.prompt.value,
        aspectRatio: els.aspectRatio.value,
        resolution: els.resolution.value,
        model: els.model.value,
        endpointId: els.endpointId.value,
      });
      const validation = validateGenerationInput(payload, account);
      if (!validation.ok) {
        setError(els, validation.message);
        if (validation.field === 'image') els.chooseImageBtn.focus();
        if (validation.field === 'prompt') els.prompt.focus();
        return;
      }
      if (!state.hasSession) {
        const signedIn = await accounts.signInWithCredentials();
        if (!signedIn) return;
      }

      setGenerateBusy(els, true);
      els.statusText.textContent = 'Starting';
      try {
        const result = await flora.generate(payload);
        els.generationId.textContent = result.generationId;
        els.resultImage.src = appendCacheBust(result.outputUrl);
        els.openOutput.href = result.outputUrl;
        els.emptyState.hidden = true;
        els.resultWrap.hidden = false;
        els.statusText.textContent = result.available ? 'Complete' : 'Generation completed; media still propagating';
        await accounts.refreshAccounts();
        await accounts.refreshAuth();
      } catch (error) {
        els.statusText.textContent = 'Failed';
        setError(els, error?.message || String(error));
        await accounts.refreshAccounts();
      } finally {
        setGenerateBusy(els, false);
      }
    });
  }
  return { bind };
}
