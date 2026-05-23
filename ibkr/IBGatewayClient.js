export class IBGatewayClient {
  constructor({ host, port, clientId }) {
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this.connected = false;
  }

  async connect() {
    this.connected = true;

    return {
      connected: true,
      host: this.host,
      port: this.port,
      clientId: this.clientId,
    };
  }

  async getAccount() {
    return {
      broker: 'IBKR',
      accountType: 'PAPER',
      connected: this.connected,
    };
  }

  async getPositions() {
    return [];
  }

  async placeOrder(order) {
    return {
      orderId: crypto.randomUUID(),
      status: 'SUBMITTED',
      order,
    };
  }
}
