import BatchView from '@/components/BatchView'

export default function BatchPage({ params }: { params: { id: string } }) {
  return <BatchView batchId={params.id} />
}
