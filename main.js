// ==UserScript==
// @name         CloseAdForCSDN
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  优化 CSDN 代码复制，解除文章复制限制，并兼容动态加载内容
// @author       AZMIAO
// @license      GNU GPLv3
// @match        *://*.csdn.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /**
     * 文章正文容器。
     * 网站结构发生变化时，只需要在这里追加选择器。
     */
    const ARTICLE_SELECTORS = [
        '#content_views',
        '.blog-content-box',
        '.article_content',
        '.markdown-body',
        'article'
    ];

    /**
     * 可能出现的代码复制按钮。
     */
    const COPY_BUTTON_SELECTORS = [
        '.hljs-button',
        '.copy-code-button',
        '.code-copy-button',
        '.copy-btn',
        '[class*="copy-code"]',
        '[class*="code-copy"]',
        'button[title*="复制"]',
        'button[data-title*="复制"]',
        'button[aria-label*="复制"]',
        '[role="button"][title*="复制"]',
        '[role="button"][data-title*="复制"]'
    ];

    const COPY_BUTTON_SELECTOR = COPY_BUTTON_SELECTORS.join(',');

    /**
     * 保存按钮提示恢复定时器。
     */
    const feedbackTimers = new WeakMap();

    /**
     * 判断节点是否位于文章正文中。
     */
    function isInArticle(node) {
        if (!node) {
            return false;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentElement;
        }

        return ARTICLE_SELECTORS.some((selector) => {
            const article = document.querySelector(selector);
            return article?.contains(node);
        });
    }

    /**
     * 判断当前选区是否位于文章正文中。
     */
    function isSelectionInArticle(selection) {
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return false;
        }

        return (
            isInArticle(selection.anchorNode) ||
            isInArticle(selection.focusNode) ||
            isInArticle(selection.getRangeAt(0).commonAncestorContainer)
        );
    }

    /**
     * 获取用户选择的纯文本。
     */
    function getSelectedText() {
        const selection = window.getSelection();

        if (!isSelectionInArticle(selection)) {
            return '';
        }

        return selection.toString();
    }

    /**
     * 判断一个元素是否可能是代码复制按钮。
     */
    function isLikelyCopyButton(element) {
        if (!(element instanceof Element)) {
            return false;
        }

        if (element.matches(COPY_BUTTON_SELECTOR)) {
            return true;
        }

        const description = [
            element.className,
            element.id,
            element.textContent,
            element.getAttribute('title'),
            element.getAttribute('data-title'),
            element.getAttribute('aria-label')
        ]
            .filter(Boolean)
            .join(' ');

        return /复制|copy/i.test(description);
    }

    /**
     * 从点击目标中查找真正的复制按钮。
     */
    function findCopyButton(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        const button = target.closest([
            COPY_BUTTON_SELECTOR,
            'button',
            '[role="button"]'
        ].join(','));

        if (!button || !isLikelyCopyButton(button)) {
            return null;
        }

        return getCodeText(button) !== null ? button : null;
    }

    /**
     * 获取元素的可见文本。
     */
    function getElementText(element) {
        if (!element) {
            return null;
        }

        /*
         * innerText 能更好地处理：
         * <ol><li>...</li></ol>
         * 以及带行号的代码结构。
         */
        return typeof element.innerText === 'string'
            ? element.innerText
            : element.textContent;
    }

    /**
     * 从复制按钮附近查找代码内容。
     */
    function getCodeText(button) {
        if (!button) {
            return null;
        }

        // 常规结构：<pre><code>...</code><button>复制</button></pre>
        const pre = button.closest('pre');

        if (pre) {
            const code = pre.querySelector('code');

            if (code) {
                return getElementText(code);
            }

            // 没有 code 标签时，克隆 pre 并删除按钮等非代码元素。
            const clone = pre.cloneNode(true);

            clone.querySelectorAll([
                COPY_BUTTON_SELECTOR,
                'button',
                '[role="button"]',
                '.toolbar',
                '.code-toolbar',
                '[class*="operate"]',
                '[class*="toolbar"]'
            ].join(',')).forEach((element) => element.remove());

            return getElementText(clone);
        }

        /*
         * 兼容代码块和工具栏处于同级或嵌套容器中的情况。
         */
        const container = button.closest([
            '.code-box',
            '.code-block',
            '.code-toolbar',
            '.highlight',
            '.hljs',
            '[class*="code-block"]',
            '[class*="codeBlock"]',
            '[class*="highlight"]'
        ].join(','));

        if (container) {
            const code = container.querySelector('pre code, code, pre');

            if (code && !code.contains(button)) {
                return getElementText(code);
            }

            if (code && code.tagName !== 'PRE') {
                return getElementText(code);
            }
        }

        /*
         * 兼容代码区域和工具栏为前后兄弟节点的情况。
         */
        let sibling = button.parentElement?.previousElementSibling;

        while (sibling) {
            if (sibling.matches('pre, code')) {
                return getElementText(sibling);
            }

            const code = sibling.querySelector?.('pre code, code, pre');

            if (code) {
                return getElementText(code);
            }

            sibling = sibling.previousElementSibling;
        }

        return null;
    }

    /**
     * Clipboard API 不可用时的复制回退方案。
     */
    function fallbackCopyText(text) {
        const textarea = document.createElement('textarea');

        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.cssText = [
            'position:fixed',
            'left:-9999px',
            'top:-9999px',
            'opacity:0',
            'pointer-events:none'
        ].join(';');

        document.documentElement.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);

        let success = false;

        try {
            success = document.execCommand('copy');
        } catch (error) {
            console.warn('[CloseAdForCSDN] 复制失败：', error);
        } finally {
            textarea.remove();
        }

        return success;
    }

    /**
     * 将文本写入剪贴板。
     */
    async function writeClipboard(text) {
        if (typeof text !== 'string') {
            return false;
        }

        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (error) {
                console.warn(
                    '[CloseAdForCSDN] Clipboard API 不可用，尝试回退方案：',
                    error
                );
            }
        }

        return fallbackCopyText(text);
    }

    /**
     * 修改复制按钮提示。
     */
    function setButtonFeedback(button, message, duration = 1200) {
        const previousTimer = feedbackTimers.get(button);

        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        button.setAttribute('data-title', message);
        button.setAttribute('aria-label', message);

        const timer = window.setTimeout(() => {
            if (button.isConnected) {
                button.setAttribute('data-title', '点击复制');
                button.setAttribute('aria-label', '点击复制');
            }

            feedbackTimers.delete(button);
        }, duration);

        feedbackTimers.set(button, timer);
    }

    /**
     * 清理网站给复制按钮添加的限制。
     */
    function sanitizeCopyButton(button) {
        if (!isLikelyCopyButton(button)) {
            return;
        }

        button.classList.remove('signin');
        button.removeAttribute('onclick');

        if (!button.getAttribute('data-title')) {
            button.setAttribute('data-title', '点击复制');
        }

        if (!button.getAttribute('aria-label')) {
            button.setAttribute('aria-label', '点击复制');
        }
    }

    /**
     * 扫描指定节点中的复制按钮。
     */
    function scanCopyButtons(root) {
        if (!(root instanceof Element) && root !== document) {
            return;
        }

        if (root instanceof Element && isLikelyCopyButton(root)) {
            sanitizeCopyButton(root);
        }

        root.querySelectorAll?.(COPY_BUTTON_SELECTOR).forEach(
            sanitizeCopyButton
        );

        /*
         * 兼容未来使用普通 button，但类名发生变化的情况。
         * 只扫描代码块内部，避免影响网页上的其他按钮。
         */
        root.querySelectorAll?.('pre button, pre [role="button"]').forEach(
            (button) => {
                if (isLikelyCopyButton(button)) {
                    sanitizeCopyButton(button);
                }
            }
        );
    }

    /**
     * 处理代码复制按钮点击。
     *
     * 使用捕获阶段和事件委托：
     * 1. 不需要给每个按钮单独绑定事件；
     * 2. 自动兼容动态加载的代码块；
     * 3. 尽可能先于网站自身点击事件执行。
     */
    async function handleCopyButtonClick(event) {
        const button = findCopyButton(event.target);

        if (!button) {
            return;
        }

        const codeText = getCodeText(button);

        if (codeText === null) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        setButtonFeedback(button, '正在复制');

        const success = await writeClipboard(codeText);

        setButtonFeedback(
            button,
            success ? '复制成功' : '复制失败',
            success ? 1200 : 1800
        );
    }

    /**
     * 处理文章正文复制。
     *
     * 优先使用 ClipboardEvent.clipboardData，它是同步操作，
     * 比 navigator.clipboard.writeText 更适合 copy 事件。
     */
    function handleArticleCopy(event) {
        const text = getSelectedText();

        if (!text) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.clipboardData) {
            event.clipboardData.clearData();
            event.clipboardData.setData('text/plain', text);
        } else {
            writeClipboard(text);
        }
    }

    /**
     * 防止网站通过 keydown 拦截 Ctrl+C / Command+C。
     *
     * 不调用 preventDefault，让浏览器继续触发原生 copy 事件。
     */
    function handleCopyShortcut(event) {
        const isCopyShortcut =
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key?.toLowerCase() === 'c';

        if (!isCopyShortcut) {
            return;
        }

        if (!getSelectedText()) {
            return;
        }

        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    /**
     * 监听动态加载出来的代码块。
     */
    function observeDynamicContent() {
        const root = document.documentElement;

        if (!root) {
            return;
        }

        scanCopyButtons(document);

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        scanCopyButtons(node);
                    }
                });
            }
        });

        observer.observe(root, {
            childList: true,
            subtree: true
        });
    }

    /*
     * 尽早注册捕获阶段事件，减少被网站自身事件拦截的可能。
     */
    window.addEventListener('click', handleCopyButtonClick, true);
    window.addEventListener('copy', handleArticleCopy, true);
    window.addEventListener('keydown', handleCopyShortcut, true);

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            observeDynamicContent,
            { once: true }
        );
    } else {
        observeDynamicContent();
    }
})();