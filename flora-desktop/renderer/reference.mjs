import { clearReferencePreview, setError, setPreviewError, showReferencePreview } from './view.mjs';

export function createReferenceController({ els, state, flora }) {
  async function loadUrlPreview(value, sequence) {
    const url = value.trim();
    if (!url) {
      els.urlLoadState.textContent = '';
      clearReferencePreview(els);
      setPreviewError(els, '');
      return;
    }
    els.urlLoadState.textContent = 'Loading...';
    try {
      const result = await flora.previewImageUrl(url);
      if (sequence !== state.urlPreviewSequence || els.imageUrl.value.trim() !== url) return;
      showReferencePreview(els, result, 'Image URL');
      els.urlLoadState.textContent = 'Loaded';
    } catch (error) {
      if (sequence !== state.urlPreviewSequence || els.imageUrl.value.trim() !== url) return;
      clearReferencePreview(els);
      els.urlLoadState.textContent = 'Could not load';
      setPreviewError(els, error?.message || String(error));
    }
  }

  function bind() {
    els.chooseImageBtn.addEventListener('click', async () => {
      setError(els, ''); setPreviewError(els, '');
      const result = await flora.selectImage();
      if (!result || result.canceled) return;
      state.urlPreviewSequence += 1;
      clearTimeout(state.urlPreviewTimer);
      state.localImageHandle = result.handle || '';
      els.selectedImageName.textContent = result.name || 'Selected image';
      els.imageUrl.value = '';
      els.urlLoadState.textContent = '';
      showReferencePreview(els, result, result.name || 'Local image');
    });

    els.imageUrl.addEventListener('input', () => {
      const value = els.imageUrl.value.trim();
      state.urlPreviewSequence += 1;
      const sequence = state.urlPreviewSequence;
      clearTimeout(state.urlPreviewTimer);
      if (value) {
        state.localImageHandle = '';
        els.selectedImageName.textContent = 'No file selected';
        clearReferencePreview(els);
        setPreviewError(els, '');
        els.urlLoadState.textContent = 'Waiting...';
        state.urlPreviewTimer = window.setTimeout(() => void loadUrlPreview(value, sequence), 450);
      } else {
        els.urlLoadState.textContent = '';
        clearReferencePreview(els);
        setPreviewError(els, '');
      }
    });
  }

  return { bind };
}
