// HTML 源码编辑器组件 —— 基于 CodeMirror 6，提供 HTML 语法高亮 + 深色主题。
// 作为受控组件：value 由父组件传入，onChange 回调通知变化。
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { indentOnInput } from '@codemirror/language';

interface HtmlEditorProps {
  value: string;                    // 当前 HTML 内容
  onChange: (value: string) => void; // 内容变化回调
  className?: string;               // 自定义容器样式
}

export function HtmlEditor({ value, onChange, className }: HtmlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 用 ref 跟踪最新 onChange，避免 EditorView 重建
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 初始化 CodeMirror 实例（只执行一次）
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),           // 行号
        history(),               // 撤销/重做历史
        indentOnInput(),         // 自动缩进
        html(),                  // HTML 语法高亮 + 自动补标签
        oneDark,                 // 深色主题
        keymap.of([...defaultKeymap, ...historyKeymap]), // 快捷键
        EditorView.updateListener.of((update) => {
          // 内容变化时通知父组件
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          // 让编辑器填满容器高度
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在挂载时创建，后续通过 value 变化更新

  // 外部 value 变化时同步到编辑器（避免循环更新）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className={className} />;
}
