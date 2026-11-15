import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, AppState } from '../shared/types';
const api: DesktopApi = {
  listDocuments: query => ipcRenderer.invoke('library:list', query),
  storageInfo: () => ipcRenderer.invoke('app:storage'),
  copyCitation: (doc, unit, query) => ipcRenderer.invoke('source:copy', doc, unit, query),
  getState: () => ipcRenderer.invoke('library:state'),
  chooseFolder: () => ipcRenderer.invoke('library:choose'),
  refresh: () => ipcRenderer.invoke('index:refresh'),
  pause: () => ipcRenderer.invoke('index:pause'),
  resume: () => ipcRenderer.invoke('index:resume'),
  retry: id => ipcRenderer.invoke('index:retry', id),
  search: query => ipcRenderer.invoke('library:search', query),
  preview: (documentId, unitId, query) => ipcRenderer.invoke('library:preview', documentId, unitId, query),
  openSource: id => ipcRenderer.invoke('source:open', id),
  revealSource: id => ipcRenderer.invoke('source:reveal', id),
  onError: callback => {
    const listener = (_event: unknown, message: string) => callback(message);
    ipcRenderer.on('library:error', listener);
    return () => { ipcRenderer.removeListener('library:error', listener); };
  },
  onState: callback => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on('library:changed', listener);
    return () => { ipcRenderer.removeListener('library:changed', listener); };
  },
};
contextBridge.exposeInMainWorld('materialFinder', api);
