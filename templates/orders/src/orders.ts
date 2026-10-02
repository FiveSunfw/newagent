export interface Order { id: string; ownerId: string; createdAt: string; amount: number; }
export function queryOrders(orders: Order[], ownerId: string): Order[] {
  if (!ownerId) throw new Error('Authentication required');
  return orders.filter(order => order.ownerId === ownerId);
}
