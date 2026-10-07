import { RequestSanitizerMiddleware } from './request-sanitizer.middleware';
import { Request, Response, NextFunction } from 'express';

describe('RequestSanitizerMiddleware', () => {
  let middleware: RequestSanitizerMiddleware;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    middleware = new RequestSanitizerMiddleware();
    mockNext = jest.fn();
    mockResponse = {};
    mockRequest = {
      headers: {
        'user-agent': 'Mozilla/5.0',
        referer: 'https://example.com',
        'x-forwarded-for': '192.168.1.1',
        'accept-language': 'en-US',
        'accept-encoding': 'gzip, deflate',
        'sec-ch-ua': '"Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
      ip: '192.168.1.1',
      ips: ['192.168.1.1'],

      socket: {
        remoteAddress: '192.168.1.1',
        remotePort: 12345,
      } as Record<string, unknown>,
    };
  });

  it('should be defined', () => {
    expect(middleware).toBeDefined();
  });

  it('should remove identifying headers', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockRequest.headers?.['user-agent']).toBeUndefined();
    expect(mockRequest.headers?.['referer']).toBeUndefined();
    expect(mockRequest.headers?.['x-forwarded-for']).toBeUndefined();
    expect(mockRequest.headers?.['accept-language']).toBeUndefined();
    expect(mockRequest.headers?.['sec-ch-ua']).toBeUndefined();
  });

  it('should anonymize IP address', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockRequest.ip).toBe('0.0.0.0');
    expect(mockRequest.ips).toEqual([]);
  });

  it('should anonymize socket information', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockRequest.socket?.remoteAddress).toBe('0.0.0.0');
    expect(mockRequest.socket?.remotePort).toBe(0);
  });

  it('anonymizes a kept-alive socket once and serves its next request', () => {
    const socket = mockRequest.socket;
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    const next = { headers: {}, socket } as unknown as Request;
    expect(() =>
      middleware.use(next, mockResponse as Response, mockNext),
    ).not.toThrow();
    expect(next.socket.remoteAddress).toBe('0.0.0.0');
    expect(mockNext).toHaveBeenCalledTimes(2);
  });

  it('should call next middleware', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle request without socket', () => {
    delete mockRequest.socket;

    expect(() => {
      middleware.use(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );
    }).not.toThrow();

    expect(mockNext).toHaveBeenCalled();
  });

  it('should remove client hints headers', () => {
    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockRequest.headers?.['sec-ch-ua-mobile']).toBeUndefined();
    expect(mockRequest.headers?.['sec-ch-ua-platform']).toBeUndefined();
  });

  it('should remove tracking headers', () => {
    mockRequest.headers = {
      ...mockRequest.headers,
      dnt: '1',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
    };

    middleware.use(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockRequest.headers?.['dnt']).toBeUndefined();
    expect(mockRequest.headers?.['sec-fetch-site']).toBeUndefined();
    expect(mockRequest.headers?.['sec-fetch-mode']).toBeUndefined();
  });
});
