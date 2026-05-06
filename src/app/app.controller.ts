import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { AppService } from './app.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Server')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('branding')
  getBranding(@Req() req: Request): {
    authorName: string | null;
    authorUrl: string | null;
  } {
    const host = req.get('Host');
    return this.appService.getBranding(host ?? undefined);
  }
}
