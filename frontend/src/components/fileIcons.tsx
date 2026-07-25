/**
 * 文件图标库
 * 根据扩展名/类型渲染 SVG，颜色对齐 Palot 暗色调。
 */
import type { FileNode } from '../types'

interface IconProps {
  node: FileNode
  expanded?: boolean
  size?: number
}

const EXT_COLORS: Record<string, string> = {
  rs: '#dea584',
  ts: '#3178c6', tsx: '#3178c6',
  js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
  json: '#cbcb41',
  toml: '#9c4221',
  yaml: '#cb171e', yml: '#cb171e',
  md: '#519aba',
  html: '#e34c26',
  css: '#563d7c',
  py: '#3572a5',
  go: '#00add8',
  java: '#b07219',
  c: '#555555', cpp: '#f34b7d', h: '#555555',
  cs: '#178600',
  sh: '#89e051',
  ps1: '#012456',
  txt: '#9d9d9d',
  lock: '#6b6b6b',
  gitignore: '#f1502f',
}

export function FileIcon({ node, expanded, size = 14 }: IconProps) {
  if (node.isFolder) {
    return expanded ? <FolderOpenIcon size={size} /> : <FolderIcon size={size} />
  }
  const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
  const color = EXT_COLORS[ext] ?? '#9d9d9d'
  // 特殊文件
  if (ext === 'lock') return <LockIcon size={size} />
  if (node.name === 'package.json' || node.name === 'Cargo.toml' || node.name === 'tsconfig.json') {
    return <ConfigIcon size={size} />
  }
  return <GenericFileIcon size={size} color={color} ext={ext} />
}

function FolderIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="text-accent/80">
      <path d="M1.5 4h4l1.5 1.5h7.5v8h-13V4z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function FolderOpenIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="text-accent/80">
      <path d="M1.5 4h4l1.5 1.5h7.5v2H1.5V4z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M1.5 7.5h12L13 13H2L1.5 7.5z" fill="currentColor" fillOpacity="0.4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function GenericFileIcon({ size, color, ext }: { size: number; color: string; ext: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ color }}>
      <path d="M3 1.5h7l3 3V14.5H3z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.18" />
      <path d="M10 1.5v3h3" stroke="currentColor" strokeWidth="1" />
      {ext && (
        <text x="8" y="11.5" textAnchor="middle" fontSize="3.5" fill="currentColor" fontFamily="monospace" fontWeight="bold">
          {ext.toUpperCase().slice(0, 4)}
        </text>
      )}
    </svg>
  )
}

function LockIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <rect x="3" y="7" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.18" />
      <path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

function ConfigIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="text-yellow-600">
      <path d="M8 1.5l1 2 2.2-.4-.4 2.2 2 1-1 2 1 2-2 1 .4 2.2-2.2-.4-1 2-1-2-2.2.4.4-2.2-2-1 1-2-1-2 2-1-.4-2.2 2.2.4 1-2z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.2" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}
