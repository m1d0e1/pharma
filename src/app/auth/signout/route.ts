import { type NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', req.url), {
    status: 302,
  })
  for (const name of ['pharma_session', 'token', 'userRole', 'subscriptionActivated']) {
    response.cookies.delete(name)
  }
  return response
}
