import { SanitizedLogger } from './sanitized-logger';

describe('SanitizedLogger', () => {
  let logger: SanitizedLogger;
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new SanitizedLogger();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  describe('log', () => {
    it('should log messages from safe contexts', () => {
      logger.log('Application started', 'NestFactory');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[LOG] NestFactory: Application started\n',
      );
    });

    it('should log messages from InstanceLoader context', () => {
      logger.log('Loading modules', 'InstanceLoader');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[LOG] InstanceLoader: Loading modules\n',
      );
    });

    it('should log messages from RoutesResolver context', () => {
      logger.log('Mapping routes', 'RoutesResolver');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[LOG] RoutesResolver: Mapping routes\n',
      );
    });

    it('should not log messages from unsafe contexts', () => {
      logger.log('Sensitive data', 'UserService');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should not log when context is undefined', () => {
      logger.log('Some message');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('should log error messages from safe contexts without stack traces', () => {
      logger.error('Something went wrong', 'stack trace here', 'NestFactory');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[ERR] NestFactory: Something went wrong\n',
      );
    });

    it('should only log first line of multiline error messages', () => {
      logger.error('Error line 1\nError line 2', '', 'NestApplication');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[ERR] NestApplication: Error line 1\n',
      );
    });

    it('should not log errors from unsafe contexts', () => {
      logger.error('nullifier 0x1234 already used', '', 'LongjingService');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should not log when context is undefined', () => {
      logger.error('Error occurred');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('warn', () => {
    it('should warn messages from safe contexts', () => {
      logger.warn('Deprecation warning', 'NestApplication');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[WARN] NestApplication: Deprecation warning\n',
      );
    });

    it('should warn messages from RouterExplorer context', () => {
      logger.warn('Route warning', 'RouterExplorer');

      expect(stdoutSpy).toHaveBeenCalledWith(
        '[WARN] RouterExplorer: Route warning\n',
      );
    });

    it('should not warn messages from unsafe contexts', () => {
      logger.warn('Unsafe warning', 'CustomService');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should not warn when context is undefined', () => {
      logger.warn('Warning message');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('debug', () => {
    it('should suppress all debug messages', () => {
      logger.debug('Debug message', 'NestFactory');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('verbose', () => {
    it('should suppress all verbose messages', () => {
      logger.verbose('Verbose message', 'NestFactory');

      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });
});
