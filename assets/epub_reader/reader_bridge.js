/**
 * DhimantAI EPUB Reader Bridge
 * Bridges epub.js running inside WebView with Flutter Study Mode.
 */

let book = null;
let rendition = null;
let currentTheme = 'light';
let currentFontSize = '100%';
let isBookReady = false;
let readerGeneration = 0;
function destroyReader() {
  readerGeneration++;
  if (rendition) rendition.destroy();
  if (book) book.destroy();
  rendition = book = null;
  isBookReady = false;
}
function activateReader(nextBook, nextRendition) {
  book = nextBook;
  rendition = nextRendition;
}

function horizontalPagePosition(reader) {
  const manager = reader?.manager;
  if (!manager?.isPaginated || manager.settings.axis !== 'horizontal' || manager.settings.direction !== 'ltr') return null;
  const container = manager.container;
  const step = manager.layout.delta;
  if (!container || !(step > 0)) return null;
  return {manager, step, offset: container.scrollLeft, maximum: Math.max(0, container.scrollWidth - container.clientWidth)};
}

function turnReaderPage(direction) {
  const reader = rendition;
  if (!reader) return;
  // epub.js advances by a whole viewport from the current offset. If scrolling
  // or a selection leaves a partial page at the end of a chapter, that step
  // exceeds scrollWidth and epub.js tries a nonexistent next spine item.
  // Stay on its navigation queue, but align within this chapter first.
  return reader.q.enqueue(() => {
    if (reader !== rendition) return;
    const position = horizontalPagePosition(reader);
    if (position) {
      const {manager, step, offset, maximum} = position;
      const index = direction > 0 ? Math.floor((offset + 0.5) / step) + 1 : Math.ceil((offset - 0.5) / step) - 1;
      const target = Math.max(0, Math.min(maximum, index * step));
      if (Math.abs(target - offset) > 0.5) { manager.scrollTo(target, 0, true); return; }
    }
    return direction > 0 ? reader.manager.next() : reader.manager.prev();
  }).then(() => { if (reader === rendition) return reader.reportLocation(); });
}

function postFlutterMessage(event, data = {}) {
  try {
    const payload = JSON.stringify({ event, ...data });
    if (window.DhimantStudyBridge) {
      window.DhimantStudyBridge({ event, ...data });
    } else if (window.FlutterChannel && window.FlutterChannel.postMessage) {
      window.FlutterChannel.postMessage(payload);
    } else {
      console.log('[EpubBridge -> Flutter]', payload);
    }
  } catch (err) {
    console.error('Failed to post message to Flutter:', err);
  }
}

function formatToc(tocItems) {
  if (!tocItems || !Array.isArray(tocItems)) return [];
  return tocItems.map(item => ({
    label: (item.label || '').trim(),
    href: item.href,
    subitems: formatToc(item.subitems)
  }));
}

function initReader(bookSource, options = {}) {
  destroyReader();
  const generation = readerGeneration;
  const current = () => generation === readerGeneration;
  // Each callback closes over its own book; a destroyed book cannot update its successor.
  let book = null;
  let rendition = null;
  const emit = (event, data) => { if (current()) postFlutterMessage(event, data); };
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

  try {
    if (loadingText) loadingText.textContent = 'Opening textbook...';

    // bookSource can be a URL, a relative path, or a base64/ArrayBuffer
    book = ePub(bookSource);

    const viewer = document.getElementById('viewer');
    rendition = book.renderTo(viewer, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated'
    });

    activateReader(book, rendition);

    // Register Themes
    rendition.themes.register('light', {
      'body': {
        'color': '#1E293B !important',
        'background-color': '#FFFFFF !important',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important',
        'line-height': '1.7 !important',
        'padding': '0 8px !important'
      },
      'img': {
        'max-width': '100% !important',
        'height': 'auto !important',
        'border-radius': '8px !important',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.06) !important',
        'cursor': 'pointer !important'
      },
      'table': {
        'border-collapse': 'collapse !important',
        'width': '100% !important',
        'margin': '12px 0 !important'
      },
      'th, td': {
        'border': '1px solid #E2E8F0 !important',
        'padding': '8px 12px !important'
      },
      'th': {
        'background-color': '#F8FAFC !important'
      }
    });

    rendition.themes.register('sepia', {
      'body': {
        'color': '#2E261F !important',
        'background-color': '#FCF9F2 !important',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important',
        'line-height': '1.7 !important',
        'padding': '0 8px !important'
      },
      'img': {
        'max-width': '100% !important',
        'height': 'auto !important',
        'border-radius': '8px !important',
        'cursor': 'pointer !important'
      },
      'th, td': {
        'border': '1px solid #E7DFD5 !important',
        'padding': '8px 12px !important'
      },
      'th': {
        'background-color': '#F3ECE0 !important'
      }
    });

    rendition.themes.register('dark', {
      'body': {
        'color': '#E2E8F0 !important',
        'background-color': '#0F172A !important',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important',
        'line-height': '1.7 !important',
        'padding': '0 8px !important'
      },
      'img': {
        'max-width': '100% !important',
        'height': 'auto !important',
        'border-radius': '8px !important',
        'filter': 'brightness(0.92) contrast(1.05) !important',
        'cursor': 'pointer !important'
      },
      'th, td': {
        'border': '1px solid #334155 !important',
        'padding': '8px 12px !important'
      },
      'th': {
        'background-color': '#1E293B !important'
      },
      'a': {
        'color': '#38BDF8 !important'
      }
    });

    if (options.theme) {
      currentTheme = options.theme;
      rendition.themes.select(currentTheme);
    } else {
      rendition.themes.select('light');
    }

    if (options.fontSize) {
      currentFontSize = options.fontSize;
      rendition.themes.fontSize(currentFontSize);
    }

    // Display initial page or resume CFI
    const startTarget = options.initialCfi || undefined;
    rendition.display(startTarget).then(() => {
      if (!current()) return;
      if (loadingEl) {
        loadingEl.style.opacity = '0';
        setTimeout(() => { if (current()) loadingEl.style.display = 'none'; }, 250);
      }
      emit('reader_ready', {
        title: book.package?.metadata?.title || '',
        creator: book.package?.metadata?.creator || ''
      });
    }).catch(err => {
      console.error('Error displaying initial rendition:', err);
      emit('error', { message: 'Failed to display rendition: ' + err });
    });

    // Content Hook: Injected into every chapter iframe
    rendition.hooks.content.register(contents => {
      if (!current()) return;
      const doc = contents.document;
      if (!doc) return;

      // VS Code owns external navigation. Flutter retains its existing bridge.
      if (window.DhimantStudyBridge) {
        doc.addEventListener('click', event => {
          const link = event.target.closest?.('a[href]');
          if (!link || !/^https:\/\//i.test(link.getAttribute('href') || '')) return;
          event.preventDefault();
          event.stopPropagation();
          emit('link_clicked', {url: link.getAttribute('href')});
        }, true);
      }

      // 1. Hook Diagrams & Images for Dual-Coding Canvas
      doc.querySelectorAll('img, svg').forEach(img => {
        img.style.cursor = 'pointer';
        img.addEventListener('click', e => {
          e.stopPropagation();
          const src = img.src || img.getAttribute('xlink:href') || '';
          const alt = img.alt || img.getAttribute('aria-label') || '';
          emit('image_tapped', { src, alt });
        });
      });

      // 2. Hook Exercise and Activity Blocks for Co-Solving
      doc.querySelectorAll('.exercise, .activity, .question, [data-exercise], .exercise-block').forEach(el => {
        el.style.position = 'relative';
        el.addEventListener('click', e => {
          // If clicked near a problem, forward text
          const exerciseText = (el.innerText || '').trim();
          if (exerciseText.length > 10) {
            emit('exercise_tapped', { text: exerciseText });
          }
        });
      });

      // 3. Touch Swiping inside iframe for smooth page turn
      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;

      doc.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchStartTime = Date.now();
        }
      }, { passive: true });

      doc.addEventListener('touchend', e => {
        if (e.changedTouches.length === 1) {
          const deltaX = e.changedTouches[0].clientX - touchStartX;
          const deltaY = e.changedTouches[0].clientY - touchStartY;
          const duration = Date.now() - touchStartTime;

          // Horizontal swipe: deltaX > 50px, duration < 450ms, vertical drift < 60px
          if (duration < 450 && Math.abs(deltaY) < 60) {
            if (deltaX < -50) {
              // Swiped Left -> Next Page
              epubControls.nextPage();
            } else if (deltaX > 50) {
              // Swiped Right -> Prev Page
              epubControls.prevPage();
            }
          }
        }
      }, { passive: true });
    });

    // Text Selection Event
    rendition.on('selected', (cfiRange, contents) => {
      if (!current()) return;
      // Resolving an element-boundary CFI against the original XML can collapse
      // a visible heading selection to one character. Capture the live range.
      const selection = contents?.document?.getSelection?.();
      const liveRange = selection?.rangeCount && !selection.isCollapsed
        ? selection.getRangeAt(0).cloneRange() : null;
      Promise.resolve(liveRange || book.getRange(cfiRange)).then(range => {
        if (!current() || !range) return;
        const text = range.toString().trim();
        if (text.length > 0) {
          const rect = range.getBoundingClientRect();
          emit('text_selected', {
            text,
            cfiRange,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
          });
        }
      }).catch(err => {
        console.error('Failed to get selected range:', err);
      });
    });

    // Page Relocation (Page Turn) Event -> Telemetry to LiveKit Agent
    rendition.on('relocated', location => {
      if (!current()) return;
      const startCfi = location.start.cfi;
      const pageIndex = location.start.displayed?.page || location.start.index || 0;
      const totalPages = location.start.displayed?.total || 0;

      // Extract current chapter heading & visible text from DOM
      let heading = '';
      let visibleText = '';
      let figures = [];

      try {
        const contents = rendition.getContents()[0];
        if (contents && contents.document) {
          const doc = contents.document;
          const h = doc.querySelector('h1, h2, h3, h4');
          if (h) heading = (h.innerText || '').trim();

          // Collect visible text snippets
          visibleText = (doc.body.innerText || '').trim().substring(0, 1500);

          // Collect image sources
          doc.querySelectorAll('img').forEach(img => {
            if (img.src && !figures.includes(img.src)) {
              figures.push(img.src);
            }
          });
        }
      } catch (e) {
        console.warn('Could not inspect current contents:', e);
      }

      const position = horizontalPagePosition(rendition);
      emit('page_changed', {
        cfi: startCfi,
        pageIndex,
        totalPages,
        atStart: !!location.atStart && (!position || position.offset <= 0.5),
        atEnd: !!location.atEnd && (!position || position.offset >= position.maximum - 0.5),
        heading,
        text: visibleText,
        figures
      });
    });

    // Load Navigation / TOC
    book.loaded.navigation.then(nav => {
      const toc = formatToc(nav.toc);
      emit('toc_loaded', { toc });
    }).catch(err => {
      console.warn('Could not load navigation TOC:', err);
    });

    // Generate Locations in background for accurate page numbering
    book.ready.then(() => {
      if (!current()) return;
      isBookReady = true;
      return book.locations.generate(1024);
    }).then(locations => {
      if (!current() || !locations) return;
      emit('locations_ready', {
        totalLocations: locations.length
      });
    }).catch(err => {
      console.warn('Locations generation skipped:', err);
    });

  } catch (err) {
    console.error('Failed to initialize EPUB reader:', err);
    emit('error', { message: err.toString() });
  }
}

// Global Controller API callable from Flutter WebViewController
window.epubControls = {
  destroy: destroyReader,
  nextPage: function() {
    return turnReaderPage(1);
  },
  prevPage: function() {
    return turnReaderPage(-1);
  },
  goToCfi: function(cfi) {
    if (rendition && cfi) rendition.display(cfi);
  },
  goToHref: function(href) {
    if (rendition && href) rendition.display(href);
  },
  setTheme: function(themeName) {
    if (rendition && themeName) {
      currentTheme = themeName;
      rendition.themes.select(themeName);
    }
  },
  setFontSize: function(sizeStr) {
    if (rendition && sizeStr) {
      currentFontSize = sizeStr;
      rendition.themes.fontSize(sizeStr);
    }
  },
  clearSelection: function() {
    try {
      const contents = rendition?.getContents();
      if (contents && contents[0] && contents[0].window) {
        contents[0].window.getSelection()?.removeAllRanges();
      }
    } catch (e) {}
  },
  cropSelect: function(cropBox) {
    try {
      const contents = rendition?.getContents();
      if (!contents || !contents[0] || !contents[0].document) {
        postFlutterMessage('crop_selected', { text: '', images: [], cropBox: cropBox });
        return;
      }
      const doc = contents[0].document;
      
      const iframe = document.querySelector('#viewer iframe');
      const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
      
      const relLeft = (cropBox.left !== undefined ? cropBox.left : 0) - iframeRect.left;
      const relTop = (cropBox.top !== undefined ? cropBox.top : 0) - iframeRect.top;
      const relRight = (cropBox.right !== undefined ? cropBox.right : (cropBox.left + cropBox.width)) - iframeRect.left;
      const relBottom = (cropBox.bottom !== undefined ? cropBox.bottom : (cropBox.top + cropBox.height)) - iframeRect.top;

      let extractedTexts = [];
      let extractedImages = [];

      // Walk text and element nodes intersecting crop rect
      const treeWalker = doc.createTreeWalker(
        doc.body,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        null,
        false
      );

      let node;
      while ((node = treeWalker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.nodeValue || '').trim();
          if (!text) continue;
          const range = doc.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            const intersects = !(r.right < relLeft || r.left > relRight || r.bottom < relTop || r.top > relBottom);
            if (intersects) {
              extractedTexts.push(text);
              break;
            }
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const tagName = node.tagName.toLowerCase();
          if (tagName === 'img') {
            const r = node.getBoundingClientRect();
            const intersects = !(r.right < relLeft || r.left > relRight || r.bottom < relTop || r.top > relBottom);
            if (intersects && node.src && !extractedImages.includes(node.src)) {
              extractedImages.push(node.src);
            }
          } else if (tagName === 'svg') {
            const r = node.getBoundingClientRect();
            const intersects = !(r.right < relLeft || r.left > relRight || r.bottom < relTop || r.top > relBottom);
            if (intersects) {
              const svgData = 'data:image/svg+xml;utf8,' + encodeURIComponent(node.outerHTML);
              if (!extractedImages.includes(svgData)) {
                extractedImages.push(svgData);
              }
            }
          }
        }
      }

      // De-duplicate text snippets in natural reading order
      const combinedText = extractedTexts.filter((t, idx, arr) => arr.indexOf(t) === idx).join(' ');
      postFlutterMessage('crop_selected', {
        text: combinedText,
        images: extractedImages,
        cropBox: cropBox
      });
    } catch (e) {
      console.warn('cropSelect error:', e);
      postFlutterMessage('crop_selected', { text: '', images: [], cropBox: cropBox });
    }
  }
};

// Signal harness is ready to receive book payload
window.addEventListener('DOMContentLoaded', () => {
  postFlutterMessage('harness_ready');
});
