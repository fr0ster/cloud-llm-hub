@path: 'auth'
service AuthService {
  function CheckAuth() returns AuthInfo;
  function CheckRoles(required: array of String) returns RoleCheckResult;
}

type AuthInfo {
  id            : String;
  roles         : array of String;
  authenticated : Boolean;
}

type RoleCheckResult {
  id        : String;
  roles     : array of String;
  required  : array of String;
  missing   : array of String;
  authorized: Boolean;
}


