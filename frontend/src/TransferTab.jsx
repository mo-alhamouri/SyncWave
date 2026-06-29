import React, { useState, useEffect, useCallback, useRef } from 'react';

const formatSize = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const TransferTab = () => {
  const [localViewMode, setLocalViewMode] = useState('columns');
  const [deviceViewMode, setDeviceViewMode] = useState('columns');
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');
  
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [localVolumes, setLocalVolumes] = useState([]);
  const [selectedLocalVolume, setSelectedLocalVolume] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [localState, setLocalState] = useState({
    columns: [], // { path, files, selectedNames: [] }
    currentPath: ''
  });
  
  const [deviceState, setDeviceState] = useState({
    columns: [],
    currentPath: '/sdcard'
  });

  const [quickLookFile, setQuickLookFile] = useState(null);
  const [mobilePreviews, setMobilePreviews] = useState({}); // path -> localTempPath
  const [isRenaming, setIsRenaming] = useState(null); // { path, name, isDevice }
  const renameInputRef = useRef(null);

  const refreshDevices = useCallback(async () => {
    if (window.electron) {
      const devs = await window.electron.listDevices();
      setDevices(devs);
      if (devs.length > 0) {
          if (!selectedDevice || !devs.find(d => d.id === selectedDevice)) {
            setSelectedDevice(devs[0].id);
          }
      } else {
        setSelectedDevice(null);
      }

      const volumes = await window.electron.listLocalVolumes();
      setLocalVolumes(volumes);
      if (volumes.length > 0 && !selectedLocalVolume) {
          setSelectedLocalVolume(volumes[0].path);
      }
    }
  }, [selectedDevice, selectedLocalVolume]);

  const fetchMobilePreviews = useCallback(async (files, deviceId) => {
      if (!deviceId) return;
      const mediaFiles = files.filter(f => !f.isDirectory && ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov'].includes(f.type?.toLowerCase()));
      for (const file of mediaFiles) {
          if (!mobilePreviews[file.path]) {
              const localPath = await window.electron.getMobilePreview(deviceId, file.path);
              if (localPath) {
                  setMobilePreviews(prev => ({ ...prev, [file.path]: localPath }));
              }
          }
      }
  }, [mobilePreviews]);

  const loadInitialLocalFiles = useCallback(async (path = '') => {
    if (window.electron) {
      setLoading(true);
      try {
        const files = await window.electron.listFiles(path, null);
        if (files.error) {
          setError('Local Access Error: ' + files.error);
        } else {
          setLocalState({
            columns: [{ path: path, files, selectedNames: [] }],
            currentPath: path
          });
        }
      } catch (err) {
        setError('Local System Error: ' + err.message);
      } finally {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    loadInitialLocalFiles('');
  }, [loadInitialLocalFiles]);

  useEffect(() => {
    if (selectedDevice) {
      const initDevice = async () => {
        setLoading(true);
        setError('');
        try {
          const files = await window.electron.listFiles('/sdcard', selectedDevice);
          if (!files.error) {
            setDeviceState({
              columns: [{ path: '/sdcard', files, selectedNames: [] }],
              currentPath: '/sdcard'
            });
            fetchMobilePreviews(files, selectedDevice);
          } else {
            setError('Android Access Error: ' + files.error);
          }
        } catch (err) {
          setError('Android System Error: ' + err.message);
        } finally {
          setLoading(false);
        }
      };
      initDevice();
    } else {
        setDeviceState({ columns: [], currentPath: '/sdcard' });
    }
  }, [selectedDevice, fetchMobilePreviews]);

  // Global Keyboard Listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (isRenaming) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (quickLookFile) {
            setQuickLookFile(null);
        } else {
            const activeState = localState.columns.some(c => c.selectedNames.length > 0) ? localState : deviceState;
            const lastCol = activeState.columns[activeState.columns.length - 1];
            if (lastCol && lastCol.selectedNames.length > 0) {
                const name = lastCol.selectedNames[lastCol.selectedNames.length - 1];
                const file = lastCol.files.find(f => f.name === name);
                if (file) setQuickLookFile(file);
            }
        }
      } else if (e.code === 'Escape') {
        setQuickLookFile(null);
        setLocalState(prev => ({ ...prev, columns: prev.columns.map(c => ({ ...c, selectedNames: [] })) }));
        setDeviceState(prev => ({ ...prev, columns: prev.columns.map(c => ({ ...c, selectedNames: [] })) }));
      } else if (e.code === 'Backspace' || e.code === 'Delete') {
          handleDeleteSelected();
      } else if (e.code === 'Enter') {
          handleRenameSelected();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [localState, deviceState, quickLookFile, isRenaming]);

  const handleDeleteSelected = async () => {
      const isDevice = deviceState.columns.some(c => c.selectedNames.length > 0);
      const state = isDevice ? deviceState : localState;
      const deviceId = isDevice ? selectedDevice : null;
      const lastCol = state.columns[state.columns.length - 1];
      if (!lastCol || lastCol.selectedNames.length === 0) return;
      if (confirm(`Delete ${lastCol.selectedNames.length} item(s)?`)) {
          setLoading(true);
          for (const name of lastCol.selectedNames) {
              const file = lastCol.files.find(f => f.name === name);
              if (file) await window.electron.deleteFile(file.path, deviceId);
          }
          const refreshed = await window.electron.listFiles(state.currentPath, deviceId);
          const setState = isDevice ? setDeviceState : setLocalState;
          setState(prev => ({
              ...prev,
              columns: prev.columns.map(c => c.path === state.currentPath ? { ...c, files: refreshed, selectedNames: [] } : c)
          }));
          setLoading(false);
      }
  };

  const handleRenameSelected = () => {
      const isDevice = deviceState.columns.some(c => c.selectedNames.length > 0);
      const state = isDevice ? deviceState : localState;
      const lastCol = state.columns[state.columns.length - 1];
      if (!lastCol || lastCol.selectedNames.length !== 1) return;
      const file = lastCol.files.find(f => f.name === lastCol.selectedNames[0]);
      if (file) setIsRenaming({ path: file.path, name: file.name, isDevice });
  };

  const finalizeRename = async (newName) => {
      const current = isRenaming;
      if (!current) return;
      setIsRenaming(null);
      if (!newName || newName === current.name) return;
      setLoading(true);
      const deviceId = current.isDevice ? selectedDevice : null;
      const result = await window.electron.renameFile(current.path, newName, deviceId);
      if (result.error) setError(result.error);
      else {
          const state = current.isDevice ? deviceState : localState;
          const refreshed = await window.electron.listFiles(state.currentPath, deviceId);
          const setState = current.isDevice ? setDeviceState : setLocalState;
          setState(prev => ({
              ...prev,
              columns: prev.columns.map(c => c.path === state.currentPath ? { ...c, files: refreshed, selectedNames: [newName] } : c)
          }));
      }
      setLoading(false);
  };

  const sortFiles = (files) => {
    if (!files) return [];
    return [...files].sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (sortBy === 'name') {
        valA = (a.name || '').toLowerCase();
        valB = (b.name || '').toLowerCase();
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const handleItemClick = async (e, file, colIndex, isDevice) => {
    e.stopPropagation();
    const state = isDevice ? deviceState : localState;
    const setState = isDevice ? setDeviceState : setLocalState;
    const deviceId = isDevice ? selectedDevice : null;

    let newSelectedNames = [];
    const lastSelected = state.columns[colIndex].selectedNames;
    if (e.shiftKey && lastSelected.length > 0) {
        const sorted = sortFiles(state.columns[colIndex].files);
        const start = sorted.findIndex(f => f.name === lastSelected[0]);
        const end = sorted.findIndex(f => f.name === file.name);
        const range = sorted.slice(Math.min(start, end), Math.max(start, end) + 1);
        newSelectedNames = range.map(f => f.name);
    } else if (e.metaKey || e.ctrlKey) {
        newSelectedNames = lastSelected.includes(file.name) ? lastSelected.filter(n => n !== file.name) : [...lastSelected, file.name];
    } else newSelectedNames = [file.name];

    const newColumns = [...state.columns.slice(0, colIndex + 1)];
    newColumns[colIndex].selectedNames = newSelectedNames;

    if (file.isDirectory && newSelectedNames.length === 1) {
      setLoading(true);
      const subFiles = await window.electron.listFiles(file.path, deviceId);
      if (!subFiles.error) {
        newColumns.push({ path: file.path, files: subFiles, selectedNames: [] });
        setState({ columns: newColumns, currentPath: file.path });
        if (isDevice) fetchMobilePreviews(subFiles, deviceId);
      } else setError('Failed to open folder: ' + subFiles.error);
      setLoading(false);
    } else setState(prev => ({ ...prev, columns: newColumns }));
  };

  const handleEmptyClick = (isDevice) => {
    const setState = isDevice ? setDeviceState : setLocalState;
    setState(prev => ({ ...prev, columns: prev.columns.map(c => ({ ...c, selectedNames: [] })) }));
  };

  const handleBack = (isDevice) => {
    const state = isDevice ? deviceState : localState;
    const setState = isDevice ? setDeviceState : setLocalState;
    if (state.columns.length > 1) {
        const newCols = state.columns.slice(0, -1);
        newCols[newCols.length - 1].selectedNames = [];
        setState({ columns: newCols, currentPath: newCols[newCols.length - 1].path });
    }
  };

  const onDragOver = (e) => e.preventDefault();

  const onDrop = async (e, isToDevice) => {
    e.preventDefault();
    try {
        const dataStr = e.dataTransfer.getData('file');
        if (!dataStr) return;
        const data = JSON.parse(dataStr);
        const targetState = isToDevice ? deviceState : localState;
        const destDir = targetState.currentPath;
        const sourceDeviceId = data.isFromDevice ? selectedDevice : null;
        const destDeviceId = isToDevice ? selectedDevice : null;
        setLoading(true);
        const filesToTransfer = data.multi ? data.files : [data];
        for (const file of filesToTransfer) {
            const destPath = (destDir.endsWith('/') ? destDir : destDir + '/') + file.name;
            const result = await window.electron.transferFile(file.path, destPath, sourceDeviceId, destDeviceId);
            if (result.error) throw new Error(result.error);
        }
        const refreshedFiles = await window.electron.listFiles(destDir, destDeviceId);
        const setState = isToDevice ? setDeviceState : setLocalState;
        setState(prev => ({ ...prev, columns: prev.columns.map(col => col.path === destDir ? { ...col, files: refreshedFiles } : col) }));
    } catch (err) { setError('Transfer failed: ' + err.message); }
    finally { setLoading(false); }
  };

  const onDragStart = (e, file, colIndex, isFromDevice) => {
    const state = isFromDevice ? deviceState : localState;
    const selected = state.columns[colIndex].selectedNames;
    if (selected.length > 1 && selected.includes(file.name)) {
        const files = state.columns[colIndex].files.filter(f => selected.includes(f.name));
        e.dataTransfer.setData('file', JSON.stringify({ multi: true, files, isFromDevice }));
    } else e.dataTransfer.setData('file', JSON.stringify({ ...file, isFromDevice }));
  };

  const renderFile = (file, colIndex, isDevice) => {
    const isFolder = file.isDirectory;
    const viewMode = isDevice ? deviceViewMode : localViewMode;
    const ext = (file.type || '').toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov';
    const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
    const isSelected = (isDevice ? deviceState : localState).columns[colIndex]?.selectedNames.includes(file.name);
    const renaming = isRenaming && isRenaming.path === file.path;
    let previewSrc = isDevice ? (mobilePreviews[file.path] ? `media://${mobilePreviews[file.path]}` : null) : `media://${file.path}`;

    return (
      <div 
        key={file.path} className={`file-item ${viewMode} ${isSelected ? 'selected' : ''}`}
        onClick={(e) => handleItemClick(e, file, colIndex, isDevice)} draggable={!isFolder}
        onDragStart={(e) => onDragStart(e, file, colIndex, isDevice)} title={file.name}
      >
        <div className="file-icon-wrapper">
          {viewMode === 'thumbnails' && previewSrc && (isVideo || isImage) ? (
            isVideo ? <video src={previewSrc} className="file-thumbnail-preview" /> : <img src={previewSrc} className="file-thumbnail-preview" alt="" />
          ) : <div className="file-icon">{isFolder ? '📁' : (ext === '.mp3' || ext === '.wav' ? '🎵' : '📄')}</div>}
        </div>
        <div className="file-info">
          {renaming ? (
              <input 
                ref={renameInputRef} className="rename-input" defaultValue={file.name} autoFocus onFocus={(e) => e.target.select()}
                onKeyDown={(e) => { if (e.key === 'Enter') finalizeRename(e.target.value); if (e.key === 'Escape') setIsRenaming(null); }}
                onBlur={(e) => finalizeRename(e.target.value)} onClick={e => e.stopPropagation()}
              />
          ) : <div className="file-name">{file.name}</div>}
          {viewMode === 'list' && <div className="file-details"><span>{isFolder ? '--' : formatSize(file.size)}</span><span>{file.type}</span></div>}
        </div>
        {(isDevice ? deviceViewMode : localViewMode) === 'columns' && isFolder && <div className="folder-arrow">›</div>}
      </div>
    );
  };

  const renderPreview = (file, isDevice) => {
    if (!file) return null;
    const ext = (file.type || '').toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov';
    const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
    let src = isDevice ? (mobilePreviews[file.path] ? `media://${mobilePreviews[file.path]}` : null) : `media://${file.path}`;
    return (
      <div className="column preview-column">
        <div className="preview-content">
          <div className="preview-image-large">
            {isVideo && src ? <video src={src} controls /> : (isImage && src ? <img src={src} alt="" /> : <div className="preview-placeholder">{file.isDirectory ? '📁' : (ext === '.mp3' || ext === '.wav' ? '🎵' : '📄')}</div>)}
          </div>
          <div className="preview-metadata">
            <h4 title={file.name}>{file.name}</h4>
            <div className="meta-row"><span>Kind:</span> <span>{file.isDirectory ? 'Folder' : (file.type?.toUpperCase().replace('.', '') || 'File')}</span></div>
            {!file.isDirectory && <div className="meta-row"><span>Size:</span> <span>{formatSize(file.size)}</span></div>}
            <div className="meta-row"><span>Modified:</span> <span>{typeof file.dateModified === 'string' ? file.dateModified : new Date(file.dateModified).toLocaleDateString()}</span></div>
          </div>
        </div>
      </div>
    );
  };

  const renderExplorer = (isDevice) => {
    const state = isDevice ? deviceState : localState;
    const viewMode = isDevice ? deviceViewMode : localViewMode;
    const setViewMode = isDevice ? setDeviceViewMode : setLocalViewMode;
    const title = isDevice ? 'Mobile Phone' : 'Computer';
    
    if (isDevice && !selectedDevice) {
      return (
        <div className="explorer-panel empty-device-state">
           <div className="explorer-header">
              <div className="explorer-title"><h3>{title}</h3></div>
           </div>
           <div className="empty-state-container">
              <div className="empty-state-icon">📱</div>
              <h4>No Mobile Device Connected</h4>
              <p>Connect your Android phone via USB to start transferring files.</p>
              <button onClick={refreshDevices} className="refresh-btn-footer">↻ Check for Devices</button>
           </div>
        </div>
      );
    }

    return (
      <div className="explorer-panel" onDragOver={onDragOver} onDrop={(e) => onDrop(e, isDevice)} onClick={() => handleEmptyClick(isDevice)}>
        <div className="explorer-header" onClick={e => e.stopPropagation()}>
          <div className="header-top-row">
            <div className="explorer-title">
              <button onClick={() => handleBack(isDevice)} className="back-btn" title="Go back" disabled={state.columns.length <= 1}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              </button>
              <span>{title}</span>
            </div>
            <div className="view-controls">
              <button onClick={() => setViewMode('icons')} className={`view-btn ${viewMode === 'icons' ? 'active' : ''}`} title="Icons">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              </button>
              <button onClick={() => setViewMode('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} title="List">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <button onClick={() => setViewMode('thumbnails')} className={`view-btn ${viewMode === 'thumbnails' ? 'active' : ''}`} title="Thumbnails">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </button>
              <button onClick={() => setViewMode('columns')} className={`view-btn ${viewMode === 'columns' ? 'active' : ''}`} title="Columns">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="3" x2="12" y2="21"/><line x1="6" y1="3" x2="6" y2="21"/><line x1="18" y1="3" x2="18" y2="21"/></svg>
              </button>
            </div>
          </div>
          
          <div className="header-bottom-row">
            {!isDevice ? (
                <select 
                  value={selectedLocalVolume || ''} 
                  onChange={(e) => {
                      setSelectedLocalVolume(e.target.value);
                      loadInitialLocalFiles(e.target.value);
                  }}
                  className="device-select" title="Switch Drives"
                >
                  {localVolumes.map(v => <option key={v.path} value={v.path}>{v.name}</option>)}
                </select>
            ) : (
              <select 
                value={selectedDevice || ''} onChange={(e) => setSelectedDevice(e.target.value)}
                className="device-select" title="Connected USB Devices"
              >
                {devices.length === 0 && <option value="">No devices found</option>}
                {devices.map(dev => <option key={dev.id} value={dev.id}>{dev.name}</option>)}
              </select>
            )}
            <div className="path-bar" title={state.currentPath}>{state.currentPath || '/'}</div>
          </div>
        </div>
        
        <div className={`file-grid ${viewMode}`}>
          {viewMode === 'columns' ? (
            <div className="columns-container">
              {state.columns.map((col, i) => (
                <div className="column" key={col.path + i}>
                  {sortFiles(col.files).map(file => renderFile(file, i, isDevice))}
                </div>
              ))}
              {state.columns.length > 0 && state.columns[state.columns.length-1].selectedNames.length === 1 && 
               !state.columns[state.columns.length-1].files.find(f => f.name === state.columns[state.columns.length-1].selectedNames[0])?.isDirectory &&
               renderPreview(state.columns[state.columns.length-1].files.find(f => f.name === state.columns[state.columns.length-1].selectedNames[0]), isDevice)
              }
            </div>
          ) : (
            <div className="grid-content">
              {sortFiles(state.columns[state.columns.length - 1]?.files).map(file => renderFile(file, state.columns.length - 1, isDevice))}
              {state.columns.length === 0 && !loading && <div className="empty-state">Nothing to show</div>}
            </div>
          )}
          {loading && <div className="spinner-overlay"><div className="spinner"></div></div>}
        </div>
      </div>
    );
  };

  return (
    <div className="tab-container">
      {quickLookFile && (
        <div className="quick-look-overlay" onClick={() => setQuickLookFile(null)}>
            <div className="quick-look-content" onClick={e => e.stopPropagation()}>
                <div className="quick-look-header"><h3>{quickLookFile.name}</h3><button className="quick-look-close" onClick={() => setQuickLookFile(null)}>&times;</button></div>
                <div className="quick-look-body">
                    {quickLookFile.isDirectory ? <div className="quick-look-placeholder">📁</div> : (
                        (() => {
                            const ext = (quickLookFile.type || '').toLowerCase();
                            const src = mobilePreviews[quickLookFile.path] ? `media://${mobilePreviews[quickLookFile.path]}` : `media://${quickLookFile.path}`;
                            if (ext === '.mp4' || ext === '.mov') return <video src={src} controls autoPlay />;
                            if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return <img src={src} alt="" />;
                            if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) {
                                return (
                                    <div className="quick-look-audio-preview" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2rem' }}>
                                        <div className="quick-look-placeholder" style={{ margin: 0, fontSize: '10rem', opacity: 0.2 }}>🎵</div>
                                        <audio src={src} controls autoPlay style={{ width: '400px' }} />
                                    </div>
                                );
                            }
                            return <div className="quick-look-placeholder">📄</div>;
                        })()
                    )}
                </div>
                <div className="quick-look-footer">
                    <div className="meta-row"><span>Size:</span> <span>{formatSize(quickLookFile.size)}</span></div>
                    <div className="meta-row"><span>Type:</span> <span>{quickLookFile.type?.toUpperCase()}</span></div>
                </div>
            </div>
        </div>
      )}

      <div className="header-section">
        <h1>Mobile <span className="gradient-text">Transfer</span></h1>
        <p>Pro-grade file management between laptop and mobile.</p>
      </div>

      <div className="glass-panel main-panel transfer-panel">
        {error && <div className="error-banner">{error} <button onClick={() => setError('')}>&times;</button></div>}
        
        <div className="transfer-header-actions">
           <div className="sort-controls">
              <span>Sort:</span>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort Criteria">
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="type">Type</option>
                <option value="dateCreated">Created</option>
                <option value="dateModified">Modified</option>
              </select>
              <button onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')} className="sort-order-btn" title="Sort Order">
                {sortOrder === 'asc' ? '↑' : '↓'}
              </button>
              <button onClick={refreshDevices} className="refresh-btn-footer" title="Refresh Devices">↻ Refresh Devices</button>
           </div>
           <div className="help-text">Space: Quick View | Shift+Click: Select Range | Enter: Rename</div>
        </div>

        <div className="transfer-layout">
          {renderExplorer(false)}
          <div className="transfer-divider">
            <div className="transfer-arrows">⇄</div>
          </div>
          {renderExplorer(true)}
        </div>
      </div>
    </div>
  );
};

export default TransferTab;
