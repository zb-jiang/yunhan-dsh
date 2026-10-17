import { DownloadOutlined, ExportOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { App, Button, Popconfirm, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import {
  instanceWorkspaceApi,
  saveBlob,
  type InstanceWorkspaceFileDto,
} from '../api/instance-workspace'

/** 字节数 → 人读大小。 */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * 实例详情页「云工作空间」面板(设计 docs/plans/2026-10-14-instance-workspace-design.md §8)。
 *
 * <p>自加载实例空间文件列表;工具栏提供上传(管理员经成员校验直通补文件)、导出 zip、刷新;
 * 行动作下载/删除。挂载于流程变量区块之后。
 *
 * @param props.instanceId 流程实例 id
 */
export function InstanceWorkspacePanel({ instanceId }: { instanceId: string }) {
  const { message } = App.useApp()
  const [files, setFiles] = useState<InstanceWorkspaceFileDto[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setFiles(await instanceWorkspaceApi.list(instanceId))
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载实例空间文件列表失败')
    } finally {
      setLoading(false)
    }
  }, [instanceId, message])

  useEffect(() => {
    void load()
  }, [load])

  /** 上传所选文件,relPath 默认取文件名(同路径覆盖,后写者胜)。 */
  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      await instanceWorkspaceApi.upload(instanceId, file.name, file)
      message.success(`已上传 ${file.name}`)
      await load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  /** 下载单文件并触发浏览器保存。 */
  const handleDownload = async (record: InstanceWorkspaceFileDto) => {
    try {
      const blob = await instanceWorkspaceApi.download(instanceId, record.relPath)
      saveBlob(blob, record.relPath.split('/').pop() ?? record.relPath)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '下载失败')
    }
  }

  /** 删除单文件。 */
  const handleDelete = async (record: InstanceWorkspaceFileDto) => {
    try {
      await instanceWorkspaceApi.remove(instanceId, record.relPath)
      message.success(`已删除 ${record.relPath}`)
      await load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  /** 导出实例空间全部文件为 zip。 */
  const handleExport = async () => {
    setExporting(true)
    try {
      const blob = await instanceWorkspaceApi.exportZip(instanceId)
      saveBlob(blob, `instance-${instanceId}-workspace.zip`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const uploadProps: UploadProps = {
    showUploadList: false,
    multiple: true,
    // 阻断 antd 默认上传,改走 handleUpload;多选时逐文件回调,各自独立提交
    beforeUpload: (file) => {
      void handleUpload(file)
      return false
    },
  }

  const columns: ColumnsType<InstanceWorkspaceFileDto> = [
    {
      title: '文件',
      dataIndex: 'relPath',
      ellipsis: true,
      render: (v: string, record) => (
        <Space size={6}>
          <Typography.Text style={{ fontFamily: 'monospace' }}>{v}</Typography.Text>
          {record.diskMissing && (
            <Tooltip title="元数据存在但磁盘文件已缺失,按不存在处理,下载/删除会 404">
              <Tag color="warning">盘上缺失</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    { title: '大小', dataIndex: 'sizeBytes', width: 90, render: (v: number) => formatBytes(v) },
    { title: '内容类型', dataIndex: 'contentType', width: 160, ellipsis: true, render: (v: string | null) => v ?? '-' },
    { title: '上传人', dataIndex: 'uploadedByLabel', width: 120, ellipsis: true, render: (v: string | null) => v ?? '-' },
    { title: '来源节点', dataIndex: 'sourceTaskId', width: 130, ellipsis: true, render: (v: string | null) => v ?? '-' },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (v: string, record) => (
        <Tooltip title={`首次写入 ${dayjs(record.createdAt).format('YYYY-MM-DD HH:mm:ss')}`}>
          {dayjs(v).format('YYYY-MM-DD HH:mm:ss')}
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => void handleDownload(record)}
          >
            下载
          </Button>
          <Popconfirm
            title="删除文件"
            description={`确定删除 ${record.relPath}?`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDelete(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        云工作空间
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        实例专属文件空间:AI 自动节点与员工办理产出的文件集中在此,任务指令可引用这里的文件;也可手动上传补充。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Upload {...uploadProps}>
          <Button type="primary" icon={<UploadOutlined />} loading={uploading}>
            上传文件
          </Button>
        </Upload>
        <Button icon={<ExportOutlined />} loading={exporting} onClick={() => void handleExport()}>
          导出 zip
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Table<InstanceWorkspaceFileDto>
        rowKey="relPath"
        columns={columns}
        dataSource={files}
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: '暂无文件' }}
      />
    </>
  )
}
